const { getDomainConfig, getDomainPrice, getDomainPaymentMethods, getDomainCurrencies, getDomainLimits } = require("../config/supported-domains");
const TagsIpfsModule = require("./tags-ipfs.module");
const TagsPartsModule = require("./tags-parts.module");
const { createEthWallet } = require("../../Wallet/modules/eth");
const { createBTCWallet } = require("../../Wallet/modules/btc");
const { createSolanaWallet } = require("../../Wallet/modules/solana");
const { generateMnemonic } = require("../../Wallet/modules/helpers");
const moment = require("moment");
const { searchTag } = require("./tags.module");
const { getTickerPrice } = require("../../binance/modules/binance.module");
const jwt = require("jsonwebtoken");
const { keccak256, solidityPacked, parseUnits, getAddress } = require("ethers");
const { usdcAtomicFromUsd, stableAtomicFromUsd } = require("./tag-pay-usdc.util");
const config = require("../../../Core/config");
const WalrusModule = require("../../Walrus/modules/walrus.module");
const TagsArweaveModule = require("./tags-arweave.module");
const { generateQRFromZelfProof, QRZelfProofExtractor } = require("./qr-zelfproof-extractor.module");
const { cleanExtraParamsForPinata, resolveEncryptVersion, stampExtraParamsVersion } = require("./tags-addresses.module");
const { formatLeaseDate, parseLeaseDate } = require("./lease-date.util");

const envTruthy = (v) => {
    if (v == null || v === "") return false;
    const s = String(v).toLowerCase();
    return s === "1" || s === "true" || s === "yes";
};

/**
 * Bill tag crypto amounts (incl. AVAX smartContractAVAX) at a fraction of list USD for cheap testing.
 *
 * Applied when the server allows reduced fees AND any of:
 * - client header `X-Zelf-Tag-Pay-Reduced-Fee: 1` only when `isTagPayReducedFeeClientHeaderHonored()` is true (see my-tags.middleware `paymentOptionsReducedFeeGate`)
 * - development API with auto discount (TAG_PAY_DEV_AUTO_REDUCED_FEE, default on in dev)
 * - development API with both `NEXT_PUBLIC_AVALANCHE_TAG_PAY_DEV` and `NEXT_PUBLIC_AVALANCHE_TAG_PAY_REDUCED_FEE`
 *   set in the **zelf** `.env` (same names as landing; ignored in production)
 *
 * Server allows reduced fees when: NODE_ENV=development OR TAG_PAY_ALLOW_REDUCED_FEE_FROM_CLIENT=true (non-dev only with header).
 *
 * Disable entirely: TAG_PAY_DEV_AMOUNT_DISCOUNT=false
 * Fraction (0–1], default 0.02: TAG_PAY_DEV_AMOUNT_FRACTION=0.02
 * In dev, disable auto 2% without header: TAG_PAY_DEV_AUTO_REDUCED_FEE=false
 *
 * @param {{ reducedFeeRequested?: boolean }} [options]
 * @returns {number|null}
 */
const resolveTagPayBillableFraction = (options = {}) => {
    const { reducedFeeRequested = false } = options;
    if (process.env.TAG_PAY_DEV_AMOUNT_DISCOUNT === "false" || process.env.TAG_PAY_DEV_AMOUNT_DISCOUNT === "0") {
        return null;
    }

    const raw = process.env.TAG_PAY_DEV_AMOUNT_FRACTION;
    const fraction = raw !== undefined && raw !== "" ? Number(raw) : 0.02;
    if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
        return null;
    }

    const serverAllows =
        config.env === "development" || process.env.TAG_PAY_ALLOW_REDUCED_FEE_FROM_CLIENT === "true";
    if (!serverAllows) {
        return null;
    }

    const inDev = config.env === "development";
    const devAutoReduced =
        inDev &&
        process.env.TAG_PAY_DEV_AUTO_REDUCED_FEE !== "false" &&
        process.env.TAG_PAY_DEV_AUTO_REDUCED_FEE !== "0";

    const devEnvMirrorsLandingFlags =
        inDev &&
        envTruthy(process.env.NEXT_PUBLIC_AVALANCHE_TAG_PAY_DEV) &&
        envTruthy(process.env.NEXT_PUBLIC_AVALANCHE_TAG_PAY_REDUCED_FEE);

    if (reducedFeeRequested || devAutoReduced || devEnvMirrorsLandingFlags) {
        return fraction;
    }

    return null;
};

/**
 * Whether `X-Zelf-Tag-Pay-Reduced-Fee` from a client may be honored (server must opt in).
 * - development: both `NEXT_PUBLIC_AVALANCHE_TAG_PAY_DEV` and `NEXT_PUBLIC_AVALANCHE_TAG_PAY_REDUCED_FEE` truthy
 * - non-development: `TAG_PAY_ALLOW_REDUCED_FEE_FROM_CLIENT=true`
 */
const isTagPayReducedFeeClientHeaderHonored = () => {
    if (config.env === "development") {
        return (
            envTruthy(process.env.NEXT_PUBLIC_AVALANCHE_TAG_PAY_DEV) &&
            envTruthy(process.env.NEXT_PUBLIC_AVALANCHE_TAG_PAY_REDUCED_FEE)
        );
    }
    return process.env.TAG_PAY_ALLOW_REDUCED_FEE_FROM_CLIENT === "true";
};

/**
 * Validate currency for domain
 * @param {string} domain - Domain name
 * @param {string} currency - Currency code
 * @returns {Object} - Validation result
 */
const validateCurrency = (domain, currency) => {
    const domainConfig = getDomainConfig(domain);

    if (!domainConfig) {
        return { valid: false, error: "Domain not supported" };
    }

    const supportedCurrencies = getDomainCurrencies(domain);
    const isValid = supportedCurrencies.includes(currency);

    return {
        valid: isValid,
        error: isValid ? null : `Currency '${currency}' not supported for domain '${domain}'`,
        supportedCurrencies,
    };
};

/**
 * Keep billed USD in nearest-cent precision before downstream crypto conversions.
 * @param {number} usdAmount
 * @returns {number}
 */
const roundBillableUsdPrice = (usdAmount) => {
    if (!Number.isFinite(usdAmount)) {
        return 0;
    }

    return Math.max(Math.round(usdAmount * 100) / 100, 0);
};

/**
 * Get payment options
 * @param {string} tagName
 * @param {string} domain
 * @param {string} duration
 * @param {Object} authUser
 * @param {{ reducedFeeRequested?: boolean }} [requestOptions]
 */
const getPaymentOptions = async (tagName, domain, duration, authUser, requestOptions = {}) => {
    const domainConfig = getDomainConfig(domain);

    // Get current tag data
    const tagData = await searchTag({ tagName, domain, domainConfig }, authUser);

    if (tagData.available) throw new Error("404:tag_not_found");

    const tagObject = tagData.tagObject;

    const priceDetails = domainConfig.getPrice(tagName, duration, tagObject.publicData.referralTagName);
    const devAmountFraction = resolveTagPayBillableFraction({
        reducedFeeRequested: Boolean(requestOptions.reducedFeeRequested),
    });
    const listPriceUsd = priceDetails.price;
    const billableUsdPrice = roundBillableUsdPrice(devAmountFraction != null ? listPriceUsd * devAmountFraction : listPriceUsd);

    const zelfPayCount = tagData.ipfs?.length || tagData.arweave?.length;

    const renewTagPayObject = await _fetchTagPayRecord(
        {
            tagName: `${tagData.tagName}.${domain}`,
            publicData: tagObject.publicData,
        },
        zelfPayCount,
        priceDetails,
        domainConfig,
    );

    if (!renewTagPayObject) {
        const error = new Error("tagPayRecord_not_found");
        error.status = 404;
        throw error;
    }

    const paymentAddress = {
        ethAddress: renewTagPayObject?.publicData?.ethAddress,
        avalancheAddress: renewTagPayObject?.publicData?.ethAddress,
        btcAddress: renewTagPayObject?.publicData?.btcAddress,
        solanaAddress: renewTagPayObject?.publicData?.solanaAddress,
        tonAddress: renewTagPayObject?.publicData?.tonAddress,
        tonServiceWallet: config.ton?.serviceWalletAddress || null,
    };

    const prices = {
        ETH: null,
        SOL: null,
        BTC: null,
        AVAX: null,
        BNB: null,
        POL: null,
        BASE: null,
        BDAG: null,
        TON: null,
    };

    // Check for enabled networks and their native currencies
    // Support both old structure (payment.currencies) and new structure (payment.networks)
    const networks = domainConfig?.tags?.payment?.networks;
    const oldCurrencies = domainConfig?.tags?.payment?.currencies;
    /** Dashboard may persist BSC as `binance` (legacy) or `bsc`. */
    const bscNetwork = networks?.bsc ?? networks?.binance;

    // ETH - Check ethereum network
    if (
        oldCurrencies?.includes("ETH") ||
        (networks?.ethereum?.enabled && networks?.ethereum?.nativeCurrency?.enabled && networks?.ethereum?.nativeCurrency?.code === "ETH")
    ) {
        prices.ETH = await calculateCryptoValue("ETH", billableUsdPrice);
    }

    // SOL - Check solana network
    if (
        oldCurrencies?.includes("SOL") ||
        (networks?.solana?.enabled && networks?.solana?.nativeCurrency?.enabled && networks?.solana?.nativeCurrency?.code === "SOL")
    ) {
        prices.SOL = await calculateCryptoValue("SOL", billableUsdPrice);
    }

    // BTC - Check bitcoin network
    if (
        oldCurrencies?.includes("BTC") ||
        (networks?.bitcoin?.enabled && networks?.bitcoin?.nativeCurrency?.enabled && networks?.bitcoin?.nativeCurrency?.code === "BTC")
    ) {
        prices.BTC = await calculateCryptoValue("BTC", billableUsdPrice);
    }

    // AVAX - Check avalanche network
    if (
        oldCurrencies?.includes("AVAX") ||
        (networks?.avalanche?.enabled && networks?.avalanche?.nativeCurrency?.enabled && networks?.avalanche?.nativeCurrency?.code === "AVAX")
    ) {
        prices.AVAX = await calculateCryptoValue("AVAX", billableUsdPrice);
    }

    // BNB - Binance Smart Chain
    if (
        oldCurrencies?.includes("BNB") ||
        (bscNetwork?.enabled && bscNetwork?.nativeCurrency?.enabled && bscNetwork?.nativeCurrency?.code === "BNB")
    ) {
        prices.BNB = await calculateCryptoValue("BNB", billableUsdPrice);
    }

    // POL — Polygon native (spot via Binance US POLUSDT; MATIC pairs are legacy / wrong spot post-rebrand)
    const polygonNativeCode = networks?.polygon?.nativeCurrency?.code;
    if (
        oldCurrencies?.includes("POL") ||
        (networks?.polygon?.enabled &&
            networks?.polygon?.nativeCurrency?.enabled &&
            (polygonNativeCode === "POL" || polygonNativeCode === "MATIC"))
    ) {
        prices.POL = await calculateCryptoValue("POL", billableUsdPrice);
    }

    // BASE — Base L2 (native ETH priced via Binance ETHUSDT; same wei math as Ethereum)
    if (
        oldCurrencies?.includes("BASE") ||
        (networks?.base?.enabled && networks?.base?.nativeCurrency?.enabled && networks?.base?.nativeCurrency?.code === "BASE")
    ) {
        prices.BASE = await calculateCryptoValue("ETH", billableUsdPrice);
    }

    // BDAG — BlockDAG EVM (chainId in config.blockdag). Native BDAG only here.
    // Do not add prices.BDAG_USDC / BDAG_USDT or JWT usdc/usdt for tag pay until those assets exist on BlockDAG.
    if (networks?.blockdag?.enabled && networks?.blockdag?.nativeCurrency?.enabled && networks?.blockdag?.nativeCurrency?.code === "BDAG") {
        prices.BDAG = await calculateCryptoValue("BDAG", billableUsdPrice);
    }

    // TON — The Open Network native TON
    if (
        oldCurrencies?.includes("TON") ||
        (networks?.ton?.enabled && networks?.ton?.nativeCurrency?.enabled && networks?.ton?.nativeCurrency?.code === "TON")
    ) {
        prices.TON = await calculateCryptoValue("TON", billableUsdPrice);
    }

    const returnData = {
        paymentAddress,
        prices,
        tagName: `${tagData.tagName}.${domain}`,
        tagPayName: `${tagData.tagName}.${domain}pay`,
        expiresAt: tagObject.publicData.expiresAt,
        initiatedAt: moment().unix(),
        ttl: moment().add("2", "hours").unix(),
        duration: parseInt(duration || 1),
        count: parseInt(renewTagPayObject.publicData?.count),
        publicData: renewTagPayObject.publicData,
        payment: {
            registeredAt: renewTagPayObject.publicData?.registeredAt,
            expiresAt: renewTagPayObject.publicData?.expiresAt,
            referralTagName: tagObject.publicData?.referralTagName,
            referralSolanaAddress: tagObject.publicData?.referralSolanaAddress,
        },
    };

    if (devAmountFraction != null) {
        returnData.devPaymentAmountDiscount = {
            fraction: devAmountFraction,
            listPriceUsd,
            billableUsdPrice,
        };
    }

    if (prices.AVAX && config.avalanche.tagPayContractAddress) {
        try {
            const initiatedAtUnix = BigInt(returnData.initiatedAt);
            const paymentId = keccak256(solidityPacked(["string", "string", "uint256"], ["ZELF_AVAX_PAY_v1", returnData.tagName, initiatedAtUnix]));
            let expectedWeiBn = avaxExpectedWeiFromUsd(billableUsdPrice, prices.AVAX.tokenPriceString);
            if (devAmountFraction != null && expectedWeiBn < 1n) {
                expectedWeiBn = 1n;
            }
            if (expectedWeiBn <= 0n) {
                throw new Error("expectedWei_non_positive");
            }
            const contractAddr = getAddress(config.avalanche.tagPayContractAddress);
            returnData.smartContractAVAX = {
                paymentId,
                expectedWei: expectedWeiBn.toString(),
                chainId: config.avalanche.chainId,
                contractAddress: contractAddr,
            };

            // Only enable when the deployed ZelfAvalanchePay includes payUsdc (constructor treasury + usdc).
            const usdcAddrRaw = (config.avalanche.tagPayUsdcAddress || "").trim();
            if (usdcAddrRaw) {
                try {
                    let expectedUsdcBn = usdcAtomicFromUsd(billableUsdPrice);
                    if (devAmountFraction != null && expectedUsdcBn < 1n) {
                        expectedUsdcBn = 1n;
                    }
                    if (expectedUsdcBn <= 0n) {
                        throw new Error("expectedUsdc_non_positive");
                    }
                    returnData.smartContractAVAX.usdc = {
                        tokenAddress: getAddress(usdcAddrRaw),
                        expectedAmount: expectedUsdcBn.toString(),
                        decimals: 6,
                    };
                    const usdcHuman = Number(expectedUsdcBn) / 1e6;
                    prices.USDC = {
                        amountToSend: parseFloat(usdcHuman.toFixed(6)),
                        price: billableUsdPrice,
                        ratePriceInUSD: 1,
                        tokenPriceString: "1",
                    };
                } catch (e) {
                    console.warn("smartContractAVAX.usdc not attached:", e?.message || e);
                }
            }

            delete returnData.paymentAddress.avalancheAddress;
        } catch (e) {
            console.warn("smartContractAVAX not attached:", e?.message || e);
        }
    }

    if (prices.BNB && config.bsc.tagPayContractAddress) {
        try {
            const initiatedAtUnix = BigInt(returnData.initiatedAt);
            const paymentId = keccak256(solidityPacked(["string", "string", "uint256"], ["ZELF_BSC_PAY_v1", returnData.tagName, initiatedAtUnix]));
            let expectedWeiBn = bnbExpectedWeiFromUsd(billableUsdPrice, prices.BNB.tokenPriceString);
            if (devAmountFraction != null && expectedWeiBn < 1n) {
                expectedWeiBn = 1n;
            }
            if (expectedWeiBn <= 0n) {
                throw new Error("expectedWei_bsc_non_positive");
            }
            const contractAddr = getAddress(config.bsc.tagPayContractAddress);
            returnData.smartContractBSC = {
                paymentId,
                expectedWei: expectedWeiBn.toString(),
                chainId: config.bsc.chainId,
                contractAddress: contractAddr,
            };

            const usdcAddrRaw = (config.bsc.tagPayUsdcAddress || "").trim();
            const usdtAddrRaw = (config.bsc.tagPayUsdtAddress || "").trim();

            const BSC_STABLE_DECIMALS = 18;

            if (usdcAddrRaw) {
                try {
                    let expectedUsdcBn = stableAtomicFromUsd(billableUsdPrice, BSC_STABLE_DECIMALS);
                    if (devAmountFraction != null && expectedUsdcBn < 1n) {
                        expectedUsdcBn = 1n;
                    }
                    if (expectedUsdcBn <= 0n) {
                        throw new Error("expectedUsdc_bsc_non_positive");
                    }
                    returnData.smartContractBSC.usdc = {
                        tokenAddress: getAddress(usdcAddrRaw),
                        expectedAmount: expectedUsdcBn.toString(),
                        decimals: BSC_STABLE_DECIMALS,
                    };
                    const usdcHuman = Number(expectedUsdcBn) / 10 ** BSC_STABLE_DECIMALS;
                    prices.BSC_USDC = {
                        amountToSend: parseFloat(usdcHuman.toFixed(8)),
                        price: billableUsdPrice,
                        ratePriceInUSD: 1,
                        tokenPriceString: "1",
                    };
                } catch (e) {
                    console.warn("smartContractBSC.usdc not attached:", e?.message || e);
                }
            }

            if (usdtAddrRaw) {
                try {
                    let expectedUsdtBn = stableAtomicFromUsd(billableUsdPrice, BSC_STABLE_DECIMALS);
                    if (devAmountFraction != null && expectedUsdtBn < 1n) {
                        expectedUsdtBn = 1n;
                    }
                    if (expectedUsdtBn <= 0n) {
                        throw new Error("expectedUsdt_bsc_non_positive");
                    }
                    returnData.smartContractBSC.usdt = {
                        tokenAddress: getAddress(usdtAddrRaw),
                        expectedAmount: expectedUsdtBn.toString(),
                        decimals: BSC_STABLE_DECIMALS,
                    };
                    const usdtHuman = Number(expectedUsdtBn) / 10 ** BSC_STABLE_DECIMALS;
                    prices.BSC_USDT = {
                        amountToSend: parseFloat(usdtHuman.toFixed(8)),
                        price: billableUsdPrice,
                        ratePriceInUSD: 1,
                        tokenPriceString: "1",
                    };
                } catch (e) {
                    console.warn("smartContractBSC.usdt not attached:", e?.message || e);
                }
            }
        } catch (e) {
            console.warn("smartContractBSC not attached:", e?.message || e);
        }
    }

    if (prices.ETH && config.ethereum.tagPayContractAddress) {
        try {
            const initiatedAtUnix = BigInt(returnData.initiatedAt);
            const paymentId = keccak256(solidityPacked(["string", "string", "uint256"], ["ZELF_ETH_PAY_v1", returnData.tagName, initiatedAtUnix]));
            let expectedWeiBn = ethExpectedWeiFromUsd(billableUsdPrice, prices.ETH.tokenPriceString);
            if (devAmountFraction != null && expectedWeiBn < 1n) {
                expectedWeiBn = 1n;
            }
            if (expectedWeiBn <= 0n) {
                throw new Error("expectedWei_eth_non_positive");
            }
            const contractAddr = getAddress(config.ethereum.tagPayContractAddress);
            returnData.smartContractETH = {
                paymentId,
                expectedWei: expectedWeiBn.toString(),
                chainId: config.ethereum.chainId,
                contractAddress: contractAddr,
            };

            const usdcAddrRaw = (config.ethereum.tagPayUsdcAddress || "").trim();
            const usdtAddrRaw = (config.ethereum.tagPayUsdtAddress || "").trim();

            /** Mainnet Circle USDC / Tether USDT use 6 decimals on Ethereum */
            const ETH_STABLE_DECIMALS = 6;

            if (usdcAddrRaw) {
                try {
                    let expectedUsdcBn = stableAtomicFromUsd(billableUsdPrice, ETH_STABLE_DECIMALS);
                    if (devAmountFraction != null && expectedUsdcBn < 1n) {
                        expectedUsdcBn = 1n;
                    }
                    if (expectedUsdcBn <= 0n) {
                        throw new Error("expectedUsdc_eth_non_positive");
                    }
                    returnData.smartContractETH.usdc = {
                        tokenAddress: getAddress(usdcAddrRaw),
                        expectedAmount: expectedUsdcBn.toString(),
                        decimals: ETH_STABLE_DECIMALS,
                    };
                    const usdcHuman = Number(expectedUsdcBn) / 10 ** ETH_STABLE_DECIMALS;
                    prices.ETH_USDC = {
                        amountToSend: parseFloat(usdcHuman.toFixed(6)),
                        price: billableUsdPrice,
                        ratePriceInUSD: 1,
                        tokenPriceString: "1",
                    };
                } catch (e) {
                    console.warn("smartContractETH.usdc not attached:", e?.message || e);
                }
            }

            if (usdtAddrRaw) {
                try {
                    let expectedUsdtBn = stableAtomicFromUsd(billableUsdPrice, ETH_STABLE_DECIMALS);
                    if (devAmountFraction != null && expectedUsdtBn < 1n) {
                        expectedUsdtBn = 1n;
                    }
                    if (expectedUsdtBn <= 0n) {
                        throw new Error("expectedUsdt_eth_non_positive");
                    }
                    returnData.smartContractETH.usdt = {
                        tokenAddress: getAddress(usdtAddrRaw),
                        expectedAmount: expectedUsdtBn.toString(),
                        decimals: ETH_STABLE_DECIMALS,
                    };
                    const usdtHuman = Number(expectedUsdtBn) / 10 ** ETH_STABLE_DECIMALS;
                    prices.ETH_USDT = {
                        amountToSend: parseFloat(usdtHuman.toFixed(6)),
                        price: billableUsdPrice,
                        ratePriceInUSD: 1,
                        tokenPriceString: "1",
                    };
                } catch (e) {
                    console.warn("smartContractETH.usdt not attached:", e?.message || e);
                }
            }

            delete returnData.paymentAddress.ethAddress;
        } catch (e) {
            console.warn("smartContractETH not attached:", e?.message || e);
        }
    }

    if (prices.POL && config.polygon.tagPayContractAddress) {
        try {
            const initiatedAtUnix = BigInt(returnData.initiatedAt);
            const paymentId = keccak256(solidityPacked(["string", "string", "uint256"], ["ZELF_POLYGON_PAY_v1", returnData.tagName, initiatedAtUnix]));
            let expectedWeiBn = polExpectedWeiFromUsd(billableUsdPrice, prices.POL.tokenPriceString);
            if (devAmountFraction != null && expectedWeiBn < 1n) {
                expectedWeiBn = 1n;
            }
            if (expectedWeiBn <= 0n) {
                throw new Error("expectedWei_pol_non_positive");
            }
            prices.POL.amountToSend = polNativeDisplayAmountFromWei(expectedWeiBn);
            const contractAddr = getAddress(config.polygon.tagPayContractAddress);
            returnData.smartContractPOLYGON = {
                paymentId,
                expectedWei: expectedWeiBn.toString(),
                chainId: config.polygon.chainId,
                contractAddress: contractAddr,
            };

            const usdcAddrRaw = (config.polygon.tagPayUsdcAddress || "").trim();
            const usdtAddrRaw = (config.polygon.tagPayUsdtAddress || "").trim();

            const POL_STABLE_DECIMALS = 6;

            if (usdcAddrRaw) {
                try {
                    let expectedUsdcBn = stableAtomicFromUsd(billableUsdPrice, POL_STABLE_DECIMALS);
                    if (devAmountFraction != null && expectedUsdcBn < 1n) {
                        expectedUsdcBn = 1n;
                    }
                    if (expectedUsdcBn <= 0n) {
                        throw new Error("expectedUsdc_pol_non_positive");
                    }
                    returnData.smartContractPOLYGON.usdc = {
                        tokenAddress: getAddress(usdcAddrRaw),
                        expectedAmount: expectedUsdcBn.toString(),
                        decimals: POL_STABLE_DECIMALS,
                    };
                    const usdcHuman = Number(expectedUsdcBn) / 10 ** POL_STABLE_DECIMALS;
                    prices.POL_USDC = {
                        amountToSend: parseFloat(usdcHuman.toFixed(6)),
                        price: billableUsdPrice,
                        ratePriceInUSD: 1,
                        tokenPriceString: "1",
                    };
                } catch (e) {
                    console.warn("smartContractPOLYGON.usdc not attached:", e?.message || e);
                }
            }

            if (usdtAddrRaw) {
                try {
                    let expectedUsdtBn = stableAtomicFromUsd(billableUsdPrice, POL_STABLE_DECIMALS);
                    if (devAmountFraction != null && expectedUsdtBn < 1n) {
                        expectedUsdtBn = 1n;
                    }
                    if (expectedUsdtBn <= 0n) {
                        throw new Error("expectedUsdt_pol_non_positive");
                    }
                    returnData.smartContractPOLYGON.usdt = {
                        tokenAddress: getAddress(usdtAddrRaw),
                        expectedAmount: expectedUsdtBn.toString(),
                        decimals: POL_STABLE_DECIMALS,
                    };
                    const usdtHuman = Number(expectedUsdtBn) / 10 ** POL_STABLE_DECIMALS;
                    prices.POL_USDT = {
                        amountToSend: parseFloat(usdtHuman.toFixed(6)),
                        price: billableUsdPrice,
                        ratePriceInUSD: 1,
                        tokenPriceString: "1",
                    };
                } catch (e) {
                    console.warn("smartContractPOLYGON.usdt not attached:", e?.message || e);
                }
            }
        } catch (e) {
            console.warn("smartContractPOLYGON not attached:", e?.message || e);
        }
    }

    if (prices.POL && !returnData.smartContractPOLYGON) {
        const q = 10 ** POL_NATIVE_DISPLAY_DECIMALS;
        prices.POL.amountToSend = Math.round(prices.POL.amountToSend * q) / q;
    }

    if (prices.BASE && config.base.tagPayContractAddress) {
        try {
            const initiatedAtUnix = BigInt(returnData.initiatedAt);
            const paymentId = keccak256(solidityPacked(["string", "string", "uint256"], ["ZELF_BASE_PAY_v1", returnData.tagName, initiatedAtUnix]));
            let expectedWeiBn = ethExpectedWeiFromUsd(billableUsdPrice, prices.BASE.tokenPriceString);
            if (devAmountFraction != null && expectedWeiBn < 1n) {
                expectedWeiBn = 1n;
            }
            if (expectedWeiBn <= 0n) {
                throw new Error("expectedWei_base_non_positive");
            }
            const contractAddr = getAddress(config.base.tagPayContractAddress);
            returnData.smartContractBASE = {
                paymentId,
                expectedWei: expectedWeiBn.toString(),
                chainId: config.base.chainId,
                contractAddress: contractAddr,
            };

            const usdcAddrRaw = (config.base.tagPayUsdcAddress || "").trim();
            const usdtAddrRaw = (config.base.tagPayUsdtAddress || "").trim();

            const BASE_STABLE_DECIMALS = 6;

            if (usdcAddrRaw) {
                try {
                    let expectedUsdcBn = stableAtomicFromUsd(billableUsdPrice, BASE_STABLE_DECIMALS);
                    if (devAmountFraction != null && expectedUsdcBn < 1n) {
                        expectedUsdcBn = 1n;
                    }
                    if (expectedUsdcBn <= 0n) {
                        throw new Error("expectedUsdc_base_non_positive");
                    }
                    returnData.smartContractBASE.usdc = {
                        tokenAddress: getAddress(usdcAddrRaw),
                        expectedAmount: expectedUsdcBn.toString(),
                        decimals: BASE_STABLE_DECIMALS,
                    };
                    const usdcHuman = Number(expectedUsdcBn) / 10 ** BASE_STABLE_DECIMALS;
                    prices.BASE_USDC = {
                        amountToSend: parseFloat(usdcHuman.toFixed(6)),
                        price: billableUsdPrice,
                        ratePriceInUSD: 1,
                        tokenPriceString: "1",
                    };
                } catch (e) {
                    console.warn("smartContractBASE.usdc not attached:", e?.message || e);
                }
            }

            if (usdtAddrRaw) {
                try {
                    let expectedUsdtBn = stableAtomicFromUsd(billableUsdPrice, BASE_STABLE_DECIMALS);
                    if (devAmountFraction != null && expectedUsdtBn < 1n) {
                        expectedUsdtBn = 1n;
                    }
                    if (expectedUsdtBn <= 0n) {
                        throw new Error("expectedUsdt_base_non_positive");
                    }
                    returnData.smartContractBASE.usdt = {
                        tokenAddress: getAddress(usdtAddrRaw),
                        expectedAmount: expectedUsdtBn.toString(),
                        decimals: BASE_STABLE_DECIMALS,
                    };
                    const usdtHuman = Number(expectedUsdtBn) / 10 ** BASE_STABLE_DECIMALS;
                    prices.BASE_USDT = {
                        amountToSend: parseFloat(usdtHuman.toFixed(6)),
                        price: billableUsdPrice,
                        ratePriceInUSD: 1,
                        tokenPriceString: "1",
                    };
                } catch (e) {
                    console.warn("smartContractBASE.usdt not attached:", e?.message || e);
                }
            }

            delete returnData.paymentAddress.ethAddress;
        } catch (e) {
            console.warn("smartContractBASE not attached:", e?.message || e);
        }
    }

    if (prices.BDAG && config.blockdag.tagPayContractAddress) {
        try {
            const initiatedAtUnix = BigInt(returnData.initiatedAt);
            const paymentId = keccak256(
                solidityPacked(["string", "string", "uint256"], ["ZELF_BLOCKDAG_PAY_v1", returnData.tagName, initiatedAtUnix]),
            );
            let expectedWeiBn = bdagExpectedWeiFromUsd(billableUsdPrice, prices.BDAG.tokenPriceString);
            if (devAmountFraction != null && expectedWeiBn < 1n) {
                expectedWeiBn = 1n;
            }
            if (expectedWeiBn <= 0n) {
                throw new Error("expectedWei_bdag_non_positive");
            }
            const contractAddr = getAddress(config.blockdag.tagPayContractAddress);
            returnData.smartContractBDAG = {
                paymentId,
                expectedWei: expectedWeiBn.toString(),
                chainId: config.blockdag.chainId,
                contractAddress: contractAddr,
            };
            delete returnData.paymentAddress.ethAddress;
        } catch (e) {
            console.warn("smartContractBDAG not attached:", e?.message || e);
        }
    }

    const signedDataPrice = jwt.sign(returnData, config.JWT_SECRET);

    return {
        ...returnData,
        signedDataPrice,
    };
};

const WAD = BigInt(10) ** BigInt(18);

/**
 * Decimal string safe for ethers.parseUnits (avoids float round-trip on exchange rates).
 * @param {string|number} v
 * @returns {string}
 */
const decimalStringForParseUnits = (v) => {
    if (typeof v === "number" && Number.isFinite(v)) {
        const s = v.toFixed(18).replace(/\.?0+$/, "");
        return s === "" ? "0" : s;
    }
    return String(v).trim();
};

/**
 * Canonical native AVAX wei: floor(usd_18dec * WAD / avaxUsdPerToken_18dec).
 * Matches "amount in AVAX" conservatively (floor) for on-chain msg.value.
 * @param {string|number} usdPrice
 * @param {string} avaxUsdPerTokenStr — AVAX price in USD as decimal string (from API, not via float display)
 * @returns {bigint}
 */
const avaxExpectedWeiFromUsd = (usdPrice, avaxUsdPerTokenStr) => {
    const usdScaled = parseUnits(decimalStringForParseUnits(usdPrice), 18);
    const pxScaled = parseUnits(decimalStringForParseUnits(avaxUsdPerTokenStr), 18);
    if (pxScaled === 0n) {
        throw new Error("avax_usd_price_zero");
    }
    return (usdScaled * WAD) / pxScaled;
};

/**
 * Canonical native BNB wei: floor(usd_18dec * WAD / bnbUsdPerToken_18dec).
 * @param {string|number} usdPrice
 * @param {string} bnbUsdPerTokenStr
 * @returns {bigint}
 */
const bnbExpectedWeiFromUsd = (usdPrice, bnbUsdPerTokenStr) => {
    const usdScaled = parseUnits(decimalStringForParseUnits(usdPrice), 18);
    const pxScaled = parseUnits(decimalStringForParseUnits(bnbUsdPerTokenStr), 18);
    if (pxScaled === 0n) {
        throw new Error("bnb_usd_price_zero");
    }
    return (usdScaled * WAD) / pxScaled;
};

/**
 * Canonical native ETH wei: floor(usd_18dec * WAD / ethUsdPerToken_18dec).
 * @param {string|number} usdPrice
 * @param {string} ethUsdPerTokenStr
 * @returns {bigint}
 */
const ethExpectedWeiFromUsd = (usdPrice, ethUsdPerTokenStr) => {
    const usdScaled = parseUnits(decimalStringForParseUnits(usdPrice), 18);
    const pxScaled = parseUnits(decimalStringForParseUnits(ethUsdPerTokenStr), 18);
    if (pxScaled === 0n) {
        throw new Error("eth_usd_price_zero");
    }
    return (usdScaled * WAD) / pxScaled;
};

/**
 * Canonical native POL wei (priced from Binance US POLUSDT spot): floor(usd_18dec * WAD / polUsdPerToken_18dec).
 * @param {string|number} usdPrice
 * @param {string} polUsdPerTokenStr — POL spot price in USD as decimal string
 * @returns {bigint}
 */
const polExpectedWeiFromUsd = (usdPrice, polUsdPerTokenStr) => {
    const usdScaled = parseUnits(decimalStringForParseUnits(usdPrice), 18);
    const pxScaled = parseUnits(decimalStringForParseUnits(polUsdPerTokenStr), 18);
    if (pxScaled === 0n) {
        throw new Error("pol_usd_price_zero");
    }
    return (usdScaled * WAD) / pxScaled;
};

/** Display / API `prices.POL.amountToSend`: 7 fractional digits, integer math from wei (no IEEE noise). */
const POL_NATIVE_DISPLAY_DECIMALS = 7;
const POL_WEI_PER_TOKEN = 10n ** 18n;
const polNativeDisplayAmountFromWei = (weiBn) => {
    const scale = 10n ** BigInt(POL_NATIVE_DISPLAY_DECIMALS);
    const quantized = (weiBn * scale) / POL_WEI_PER_TOKEN;
    return Number(quantized) / 10 ** POL_NATIVE_DISPLAY_DECIMALS;
};

/**
 * Canonical native BDAG wei: floor(usd_18dec * WAD / bdagUsdPerToken_18dec).
 * @param {string|number} usdPrice
 * @param {string} bdagUsdPerTokenStr — BDAG price in USD as decimal string
 * @returns {bigint}
 */
const bdagExpectedWeiFromUsd = (usdPrice, bdagUsdPerTokenStr) => {
    const usdScaled = parseUnits(decimalStringForParseUnits(usdPrice), 18);
    const pxScaled = parseUnits(decimalStringForParseUnits(bdagUsdPerTokenStr), 18);
    if (pxScaled === 0n) {
        throw new Error("bdag_usd_price_zero");
    }
    return (usdScaled * WAD) / pxScaled;
};

const calculateCryptoValue = async (token = "ETH", price_) => {
    try {
        // Special handling for tokens not available on Binance
        const FALLBACK_PRICES = {
            BDAG: "0.00001805", // string to avoid IEEE 754 noise in decimalStringForParseUnits
        };

        let tokenPrice;

        // Check if token has a fallback price
        if (FALLBACK_PRICES[token]) {
            tokenPrice = FALLBACK_PRICES[token];
        } else {
            // Fetch from Binance
            const { price } = await getTickerPrice({ symbol: `${token}` });
            if (!price) throw new Error(`Unable to fetch ${token} price`);
            tokenPrice = price;
        }

        const cryptoValue = price_ / tokenPrice;
        const tokenPriceString = decimalStringForParseUnits(tokenPrice);

        return {
            amountToSend: parseFloat(cryptoValue.toFixed(7)),
            ratePriceInUSD: parseFloat(parseFloat(tokenPrice).toFixed(5)),
            price: price_,
            tokenPriceString,
        };
    } catch (error) {
        // If token is not supported, log warning and return null
        console.warn(`Unable to calculate price for ${token}:`, error.message);
        return null;
    }
};

/**
 * check if the tag pay object requires an update
 * @param {Object} tagPayObject
 * @param {Object} priceDetails
 * @returns {boolean} - true if the tag pay object requires an update, false otherwise
 */
const _requiresUpdate = async (tagPayObject, priceDetails, tagObject) => {
    const sameDuration = !tagPayObject || tagPayObject?.publicData?.duration == priceDetails.duration;

    if (!tagPayObject) return false;

    const registeredAtCondition = Boolean(
        tagObject.publicData.registeredAt &&
        tagPayObject?.publicData?.registeredAt &&
        moment(tagObject.publicData.registeredAt).isAfter(moment(tagPayObject?.publicData?.registeredAt)),
    );

    if (registeredAtCondition) return true;

    if (!sameDuration && tagPayObject?.zelfProofQRCode) {
        await TagsIpfsModule.unPinFiles([tagPayObject.ipfsId]);

        return true;
    }
};

/**
 * fetch the tag pay record
 * @param {Object} tagObject
 * @param {number} currentCount
 * @param {Object} priceDetails
 * @param {Object} domainConfig
 * @returns {Object} - tag pay object
 */
const _fetchTagPayRecord = async (tagObject, currentCount, priceDetails, domainConfig) => {
    const { tagName } = tagObject;

    const tagPayName = `${tagName}pay`;

    let tagPayRecords = await searchTag({ tagName: tagPayName, domainConfig, environment: "ipfs", type: "mainnet" });

    const tagPayObject = tagPayRecords.tagObject || {};

    const requiresUpdate = await _requiresUpdate(tagPayObject, priceDetails, tagObject);

    if (!tagPayObject?.id || requiresUpdate) {
        const newTagPayObject = await createTagPay(
            {
                ...tagPayObject,
                tagPayName,
            },
            tagObject,
            priceDetails,
            currentCount + 1,
            domainConfig,
        );

        return newTagPayObject.tagObject;
    }

    return tagPayObject;
};



/**
 * create tag pay
 * @param {string} tagPayName
 * @param {Object} tagObject
 * @param {Object} priceDetails
 * @param {number} currentCount
 * @param {Object} domainConfig
 * @returns {Object} - Tag pay object
 */
const createTagPay = async (tagPayObject, tagObject, priceDetails, currentCount, domainConfig) => {
    const mnemonic = generateMnemonic(12);
    const jsonfile = require("../../../config/0012589021.json");
    const eth = createEthWallet(mnemonic);
    const btc = createBTCWallet(mnemonic);
    const solana = await createSolanaWallet(mnemonic);

    const dataToEncrypt = {
        publicData: {
            ethAddress: eth.address,
            solanaAddress: solana.address,
            btcAddress: btc.address,
            customerZelfName: tagObject.tagName,
            [domainConfig.getTagKey()]: tagPayObject.tagPayName,
            currentCount: `${currentCount}`,
        },
        metadata: {
            mnemonic,
        },
        faceBase64: jsonfile.faceBase64,
        password: jsonfile.password,
        _id: tagPayObject.tagPayName,
        tolerance: "REGULAR",
        addServerPassword: true,
    };

    await TagsPartsModule.generateZelfProof(dataToEncrypt, tagPayObject);

    if (!tagPayObject.publicData) tagPayObject.publicData = {};

    tagPayObject.publicData.ethAddress = eth.address;
    tagPayObject.publicData.btcAddress = btc.address;
    tagPayObject.publicData.solanaAddress = solana.address;

    const payload = {
        base64: tagPayObject.zelfProofQRCode,
        name: tagPayObject.tagPayName,
        metadata: {
            hasPassword: tagObject.publicData.hasPassword,
            type: "mainnet",
            ethAddress: tagPayObject.publicData.ethAddress,
            solanaAddress: tagPayObject.publicData.solanaAddress,
            btcAddress: tagPayObject.publicData.btcAddress,
            [domainConfig.getTagKey()]: tagPayObject.tagPayName,
            extraParams: JSON.stringify({
                expiresAt: formatLeaseDate(100, "year"),
                registeredAt: formatLeaseDate(),
                price: priceDetails.price,
                duration: priceDetails.duration,
                count: `${currentCount}`,
            }),
        },
        pinIt: true,
    };

    let ipfs = await TagsIpfsModule.insert(payload, { pro: true });

    ipfs = TagsIpfsModule.formatRecord(ipfs);

    return {
        ipfs: [ipfs],
        tagObject: {
            ...ipfs,
            zelfProofQRCode: tagObject.zelfProofQRCode,
            zelfProof: tagObject.zelfProof,
        },
        available: false,
        arweave: [],
    };
};

/**
 * Get pricing table for all domains
 * @returns {Object} - Pricing table
 */
const getPricingTable = () => {
    const pricingTable = {};

    Object.entries(require("../config/supported-domains").SUPPORTED_DOMAINS).forEach(([domain, config]) => {
        pricingTable[domain] = {
            basePrice: config.price,
            yearly: getDomainPrice(domain, "yearly"),
            lifetime: getDomainPrice(domain, "lifetime"),
            currencies: getDomainCurrencies(domain),
            methods: getDomainPaymentMethods(domain),
            discounts: config.payment?.discounts || {},
            limits: getDomainLimits(domain),
        };
    });

    return pricingTable;
};

const buildMetadata = (params, tagObject, domainConfig) => {
    tagObject.fullTagName = `${params.tagName}.${params.domain}`;

    const storageKey = domainConfig.getTagKey();
    const domain = tagObject.publicData.domain || params.domain || "zelf";
    const price = params.price || tagObject.publicData.price;
    const duration = params.duration || tagObject.publicData.duration;

    const metadata = {
        [storageKey]: tagObject.fullTagName,
        domain,
        extraParams: stampExtraParamsVersion(
            {
                origin: tagObject.publicData.origin || "online",
                price,
                duration: tagObject.publicData.duration ? `${Number(tagObject.publicData.duration) + Number(duration)}` : duration,
                registeredAt: tagObject.publicData.registeredAt || formatLeaseDate(),
                renewedAt: tagObject.publicData.type === "mainnet" ? formatLeaseDate() : undefined,
                expiresAt: parseLeaseDate(tagObject.publicData.expiresAt).add(duration, "year").format("YYYY-MM-DD HH:mm:ss"),
                type: "mainnet",
                hasPassword: tagObject.publicData.hasPassword,
                eventID: params.eventID || undefined,
                eventPrice: params.eventPrice || undefined,
            },
            resolveEncryptVersion(tagObject.publicData)
        ),
    };

    if (tagObject.publicData.referralTagName) {
        metadata.referral = {
            tagName: tagObject.publicData.referralTagName,
            solanaAddress: tagObject.publicData.referralSolanaAddress,
        };

        metadata.referralTagName = metadata.referral.tagName;

        metadata.referral = JSON.stringify(metadata.referral);
    }

    metadata.extraParams = JSON.stringify(cleanExtraParamsForPinata(metadata.extraParams));

    return { metadata, fullTagName: tagObject.fullTagName };
};

/**
 * Ensure tagObject has a data-URL QR for storage (IPFS / Walrus / Arweave).
 * Tries Arweave then IPFS gateway URLs, then optional decode from QR image, then zelfProof regeneration.
 */
const ensureZelfProofQRCode = async (tagObject) => {
    if (tagObject.zelfProofQRCode && typeof tagObject.zelfProofQRCode === "string" && tagObject.zelfProofQRCode.trim() !== "") {
        return;
    }

    const fromUrls = await TagsPartsModule.urlToBase64First([tagObject.url, tagObject.ipfsContentUrl]);
    if (fromUrls) {
        tagObject.zelfProofQRCode = fromUrls;
    }

    if (tagObject.zelfProofQRCode && !tagObject.zelfProof && !tagObject.publicData?.zelfProof) {
        try {
            const extracted = await QRZelfProofExtractor.extractZelfProof(tagObject.zelfProofQRCode);
            if (extracted && QRZelfProofExtractor.validateZelfProof(extracted)) {
                tagObject.zelfProof = extracted;
                if (tagObject.publicData) tagObject.publicData.zelfProof = extracted;
            }
        } catch (_) {
            /* optional: QR may still be valid for re-upload without decoded proof */
        }
    }

    if (tagObject.zelfProofQRCode && typeof tagObject.zelfProofQRCode === "string" && tagObject.zelfProofQRCode.trim() !== "") {
        return;
    }

    const zelfProof = tagObject.zelfProof || tagObject.publicData?.zelfProof;

    if (!zelfProof) {
        const err = new Error("zelf_proof_qr_unavailable");
        err.status = 500;
        throw err;
    }

    const qr = await generateQRFromZelfProof(zelfProof);

    if (!qr || typeof qr !== "string") {
        const err = new Error("zelf_proof_qr_regeneration_failed");
        err.status = 500;
        throw err;
    }

    tagObject.zelfProofQRCode = qr;
};

const storeInWalrus = async (tagObject, domainConfig, metadata) => {
    tagObject.walrus = await WalrusModule.tagRegistration(
        tagObject.zelfProofQRCode,
        { hasPassword: metadata.hasPassword, zelfProof: metadata.zelfProof, publicData: metadata },
        domainConfig,
    );

    tagObject.walrus = tagObject.walrus?.blobId;

    return tagObject.walrus;
};

const storeInIPFS = async (tagObject, domainConfig, metadata) => {
    await TagsIpfsModule.unpinContinuationSiblings(tagObject.fullTagName);
    await TagsIpfsModule.deleteFiles([tagObject.ipfsId || tagObject.id]);

    tagObject.ipfs = await TagsIpfsModule.insertSearchablePins(
        {
            base64: tagObject.zelfProofQRCode,
            name: tagObject.fullTagName,
            reserved: metadata,
            addresses: tagObject.publicData,
            pinIt: true,
        },
        { pro: true },
    );

    const ipfsRec = tagObject.ipfs;
    if (ipfsRec?.id != null && ipfsRec.id !== "") {
        tagObject.ipfsId = ipfsRec.id;
        tagObject.id = ipfsRec.id;
    }

    return tagObject.ipfs;
};

const storeInArweave = async (tagObject, domainConfig, metadata) => {
    tagObject.arweave = await TagsArweaveModule.tagRegistration(tagObject.zelfProofQRCode, {
        hasPassword: metadata.hasPassword,
        zelfProof: metadata.zelfProof,
        publicData: metadata,
        fileName: tagObject.tagName,
    });

    return tagObject.arweave;
};

module.exports = {
    validateCurrency,
    isTagPayReducedFeeClientHeaderHonored,
    roundBillableUsdPrice,
    getPaymentOptions,
    getPricingTable,
    buildMetadata,
    ensureZelfProofQRCode,
    storeInWalrus,
    storeInIPFS,
    storeInArweave,
};
