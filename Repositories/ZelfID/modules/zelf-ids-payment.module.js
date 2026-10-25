/**
 * Zelf ID v4 payment metadata, quotes, and store. Tags v3.6 payment files must not import this.
 */
const moment = require("moment");
const jwt = require("jsonwebtoken");
const { keccak256, solidityPacked, parseUnits, getAddress } = require("ethers");
const config = require("../../../Core/config");
const { getDomainConfig } = require("../../Tags/config/supported-domains");
const { buildSearchablePinPages, fitExtraParamsForPin, resolveEncryptVersion, stampExtraParamsVersion } = require("../../Tags/modules/tags-addresses.module");
const { formatLeaseDate, parseLeaseDate } = require("../../Tags/modules/lease-date.util");
const TagsIpfsModule = require("../../Tags/modules/tags-ipfs.module");
const TagsArweaveModule = require("../../Tags/modules/tags-arweave.module");
const TagsSearchModule = require("../../Tags/modules/tags-search.module");
const TagsPartsModule = require("../../Tags/modules/tags-parts.module");
const { generateQRFromZelfProof, QRZelfProofExtractor } = require("../../Tags/modules/qr-zelfproof-extractor.module");
const { usdcAtomicFromUsd, stableAtomicFromUsd } = require("../../Tags/modules/tag-pay-usdc.util");
const { getTickerPrice } = require("../../binance/modules/binance.module");
const { createEthWallet } = require("../../Wallet/modules/eth");
const { createBTCWallet } = require("../../Wallet/modules/btc");
const { createSolanaWallet } = require("../../Wallet/modules/solana");
const { generateMnemonic } = require("../../Wallet/modules/helpers");
const {
    resolveV4PaymentStamp,
    resolvePaidExpiresAt,
    resolvePaidDurationStamp,
    resolveUpgradePlan,
    normalizePaymentDuration,
    getCanonicalMainnetName,
    getZelfIdCheckoutPrice,
    getZelfIdPrice,
    isFreeOriginLease,
    effectivePlan,
    paymentDurationYears,
    isExpiresAtPassed,
    FREE_EXPIRATION_YEARS,
} = require("./zelf-id-plan.module");
const ZelfIdPartsModule = require("./zelf-id-parts.module");

const envTruthy = (v) => {
    if (v == null || v === "") return false;
    const s = String(v).toLowerCase();
    return s === "1" || s === "true" || s === "yes";
};

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

    const serverAllows = config.env === "development" || process.env.TAG_PAY_ALLOW_REDUCED_FEE_FROM_CLIENT === "true";
    if (!serverAllows) {
        return null;
    }

    const inDev = config.env === "development";
    const devAutoReduced = inDev && process.env.TAG_PAY_DEV_AUTO_REDUCED_FEE !== "false" && process.env.TAG_PAY_DEV_AUTO_REDUCED_FEE !== "0";

    const devEnvMirrorsLandingFlags =
        inDev && envTruthy(process.env.NEXT_PUBLIC_AVALANCHE_TAG_PAY_DEV) && envTruthy(process.env.NEXT_PUBLIC_AVALANCHE_TAG_PAY_REDUCED_FEE);

    if (reducedFeeRequested || devAutoReduced || devEnvMirrorsLandingFlags) {
        return fraction;
    }

    return null;
};

const isTagPayReducedFeeClientHeaderHonored = () => {
    if (config.env === "development") {
        return envTruthy(process.env.NEXT_PUBLIC_AVALANCHE_TAG_PAY_DEV) && envTruthy(process.env.NEXT_PUBLIC_AVALANCHE_TAG_PAY_REDUCED_FEE);
    }
    return process.env.TAG_PAY_ALLOW_REDUCED_FEE_FROM_CLIENT === "true";
};

const roundBillableUsdPrice = (usdAmount, options = {}) => {
    if (!Number.isFinite(usdAmount) || usdAmount <= 0) {
        return 0;
    }

    const rounded = Math.max(Math.round(usdAmount * 100) / 100, 0);
    if (options.keepPositive && rounded === 0) return 0.01;
    return rounded;
};

const WAD = BigInt(10) ** BigInt(18);

const decimalStringForParseUnits = (v) => {
    if (typeof v === "number" && Number.isFinite(v)) {
        const s = v.toFixed(18).replace(/\.?0+$/, "");
        return s === "" ? "0" : s;
    }
    return String(v).trim();
};

const expectedWeiFromUsd = (usdPrice, tokenUsdPerTokenStr, zeroError) => {
    const usdScaled = parseUnits(decimalStringForParseUnits(usdPrice), 18);
    const pxScaled = parseUnits(decimalStringForParseUnits(tokenUsdPerTokenStr), 18);
    if (pxScaled === 0n) {
        throw new Error(zeroError);
    }
    return (usdScaled * WAD) / pxScaled;
};

const avaxExpectedWeiFromUsd = (usdPrice, avaxUsdPerTokenStr) => expectedWeiFromUsd(usdPrice, avaxUsdPerTokenStr, "avax_usd_price_zero");
const bnbExpectedWeiFromUsd = (usdPrice, bnbUsdPerTokenStr) => expectedWeiFromUsd(usdPrice, bnbUsdPerTokenStr, "bnb_usd_price_zero");
const ethExpectedWeiFromUsd = (usdPrice, ethUsdPerTokenStr) => expectedWeiFromUsd(usdPrice, ethUsdPerTokenStr, "eth_usd_price_zero");
const polExpectedWeiFromUsd = (usdPrice, polUsdPerTokenStr) => expectedWeiFromUsd(usdPrice, polUsdPerTokenStr, "pol_usd_price_zero");
const bdagExpectedWeiFromUsd = (usdPrice, bdagUsdPerTokenStr) => expectedWeiFromUsd(usdPrice, bdagUsdPerTokenStr, "bdag_usd_price_zero");

const POL_NATIVE_DISPLAY_DECIMALS = 7;
const POL_WEI_PER_TOKEN = 10n ** 18n;
const polNativeDisplayAmountFromWei = (weiBn) => {
    const scale = 10n ** BigInt(POL_NATIVE_DISPLAY_DECIMALS);
    const quantized = (weiBn * scale) / POL_WEI_PER_TOKEN;
    return Number(quantized) / 10 ** POL_NATIVE_DISPLAY_DECIMALS;
};

const calculateCryptoValue = async (token = "ETH", price_) => {
    try {
        const FALLBACK_PRICES = {
            BDAG: "0.00001805",
        };

        let tokenPrice;

        if (FALLBACK_PRICES[token]) {
            tokenPrice = FALLBACK_PRICES[token];
        } else {
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
        console.warn(`Unable to calculate price for ${token}:`, error.message);
        return null;
    }
};

const _requiresUpdate = async (tagPayObject, priceDetails, tagObject) => {
    const sameDuration = !tagPayObject || tagPayObject?.publicData?.duration == priceDetails.duration;

    if (!tagPayObject) return false;

    const registeredAtCondition = Boolean(
        tagObject.publicData.registeredAt &&
            tagPayObject?.publicData?.registeredAt &&
            parseLeaseDate(tagObject.publicData.registeredAt).isAfter(parseLeaseDate(tagPayObject?.publicData?.registeredAt))
    );

    if (registeredAtCondition) return true;

    if (!sameDuration && tagPayObject?.zelfProofQRCode) {
        await TagsIpfsModule.unPinFiles([tagPayObject.ipfsId]);

        return true;
    }
};

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

    await ZelfIdPartsModule.generateZelfProof(dataToEncrypt, tagPayObject);

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

const _fetchTagPayRecord = async (tagObject, currentCount, priceDetails, domainConfig) => {
    const { tagName } = tagObject;
    const tagPayName = `${tagName}pay`;

    const tagPayRecords = await TagsSearchModule.searchTag({
        tagName: tagPayName,
        domainConfig,
        environment: "ipfs",
        type: "mainnet",
    });

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
            domainConfig
        );

        return newTagPayObject.tagObject;
    }

    return tagPayObject;
};

const attachStableQuote = ({
    returnData,
    prices,
    contractKey,
    tokenKey,
    addressRaw,
    billableUsdPrice,
    decimals,
    humanDigits,
    priceKey,
    errorLabel,
    devAmountFraction,
}) => {
    if (!addressRaw) return;

    try {
        let expectedBn = stableAtomicFromUsd(billableUsdPrice, decimals);
        if (devAmountFraction != null && expectedBn < 1n) {
            expectedBn = 1n;
        }
        if (expectedBn <= 0n) {
            throw new Error(errorLabel);
        }
        returnData[contractKey][tokenKey] = {
            tokenAddress: getAddress(addressRaw),
            expectedAmount: expectedBn.toString(),
            decimals,
        };
        const human = Number(expectedBn) / 10 ** decimals;
        prices[priceKey] = {
            amountToSend: parseFloat(human.toFixed(humanDigits)),
            price: billableUsdPrice,
            ratePriceInUSD: 1,
            tokenPriceString: "1",
        };
    } catch (e) {
        console.warn(`${contractKey}.${tokenKey} not attached:`, e?.message || e);
    }
};

const attachEvmPayQuote = ({
    returnData,
    prices,
    nativePrice,
    configBlock,
    versionPrefix,
    expectedWeiFn,
    weiError,
    contractKey,
    chainId,
    usdcAddr,
    usdtAddr,
    stableDecimals,
    stableHumanDigits,
    usdcPriceKey,
    usdtPriceKey,
    billableUsdPrice,
    devAmountFraction,
    deleteEthAddress,
    deleteAvalancheAddress,
    alignPolDisplay,
}) => {
    if (!nativePrice || !configBlock?.tagPayContractAddress) return;

    try {
        const initiatedAtUnix = BigInt(returnData.initiatedAt);
        const paymentId = keccak256(solidityPacked(["string", "string", "uint256"], [versionPrefix, returnData.tagName, initiatedAtUnix]));
        let expectedWeiBn = expectedWeiFn(billableUsdPrice, nativePrice.tokenPriceString);
        if (devAmountFraction != null && expectedWeiBn < 1n) {
            expectedWeiBn = 1n;
        }
        if (expectedWeiBn <= 0n) {
            throw new Error(weiError);
        }
        if (alignPolDisplay) {
            prices.POL.amountToSend = polNativeDisplayAmountFromWei(expectedWeiBn);
        }
        const contractAddr = getAddress(configBlock.tagPayContractAddress);
        returnData[contractKey] = {
            paymentId,
            expectedWei: expectedWeiBn.toString(),
            chainId,
            contractAddress: contractAddr,
        };

        if (usdcAddr !== undefined) {
            attachStableQuote({
                returnData,
                prices,
                contractKey,
                tokenKey: "usdc",
                addressRaw: (usdcAddr || "").trim(),
                billableUsdPrice,
                decimals: stableDecimals,
                humanDigits: stableHumanDigits,
                priceKey: usdcPriceKey,
                errorLabel: `expectedUsdc_${contractKey}_non_positive`,
                devAmountFraction,
            });
        }

        if (usdtAddr !== undefined) {
            attachStableQuote({
                returnData,
                prices,
                contractKey,
                tokenKey: "usdt",
                addressRaw: (usdtAddr || "").trim(),
                billableUsdPrice,
                decimals: stableDecimals,
                humanDigits: stableHumanDigits,
                priceKey: usdtPriceKey,
                errorLabel: `expectedUsdt_${contractKey}_non_positive`,
                devAmountFraction,
            });
        }

        if (deleteAvalancheAddress) {
            delete returnData.paymentAddress.avalancheAddress;
        }
        if (deleteEthAddress) {
            delete returnData.paymentAddress.ethAddress;
        }
    } catch (e) {
        console.warn(`${contractKey} not attached:`, e?.message || e);
    }
};

/**
 * Lease expiry stays on `expiresAt`. A Free name that buys a term stores that term on `planExpiresAt`
 * and does not move the 100-year lease. A name that was paid from the start has no `planExpiresAt`;
 * its plan end remains `expiresAt` (unchanged behaviour).
 * @returns {{ leaseExpiresAt: string|undefined, planExpiresAt: string|undefined, duration: string }}
 */
const resolveNameAndPlanTerm = ({ basePublicData = {}, duration, plan }) => {
    const purchased = normalizePaymentDuration(duration);
    const lifetime = purchased === "lifetime";
    const freeOrigin = isFreeOriginLease(basePublicData);
    const planTermOpen = Boolean(basePublicData.planExpiresAt) && !isExpiresAtPassed({ expiresAt: basePublicData.planExpiresAt });
    const samePlan = String(basePublicData.plan || "").toLowerCase() === String(plan || "").toLowerCase();

    const leaseDuration =
        basePublicData.duration != null && `${basePublicData.duration}` !== ""
            ? normalizePaymentDuration(basePublicData.duration)
            : purchased;

    if (freeOrigin || basePublicData.planExpiresAt) {
        const leaseExpiresAt = basePublicData.expiresAt;
        const planDuration = lifetime
            ? "lifetime"
            : planTermOpen && samePlan
              ? resolvePaidDurationStamp({
                    publicData: { ...basePublicData, plan: basePublicData.plan || plan, expiresAt: basePublicData.planExpiresAt },
                    duration: purchased,
                })
              : purchased;
        const planExpiresAt = lifetime
            ? undefined
            : planTermOpen && samePlan
              ? parseLeaseDate(basePublicData.planExpiresAt).add(paymentDurationYears(purchased), "year").format("YYYY-MM-DD HH:mm:ss")
              : formatLeaseDate(paymentDurationYears(purchased), "year");
        return {
            leaseExpiresAt,
            planExpiresAt,
            duration: leaseDuration,
            planDuration,
        };
    }

    return {
        leaseExpiresAt: resolvePaidExpiresAt({ publicData: basePublicData, duration: purchased }),
        planExpiresAt: undefined,
        duration: resolvePaidDurationStamp({ publicData: basePublicData, duration: purchased }),
    };
};

const buildMetadata = (params, tagObject, domainConfig) => {
    const domain = tagObject.publicData.domain || params.domain || "zelf";
    tagObject.fullTagName = getCanonicalMainnetName(params.tagName || tagObject.publicData.tagName || tagObject.publicData.zelfName, domain);

    const storageKey = domainConfig.getTagKey();
    const basePublicData = params.basePublicData || tagObject.publicData;
    const price = params.price || basePublicData.price;
    const duration = normalizePaymentDuration(params.duration || basePublicData.duration);
    const encryptVersion = resolveEncryptVersion(tagObject.publicData);
    const requestedPlan = params.plan || params.requestedPlan;

    const v4Stamp = resolveV4PaymentStamp({
        tagName: params.tagName || tagObject.fullTagName,
        encryptVersion,
        duration,
        requestedPlan,
        publicData: basePublicData,
    });
    const plan = resolveUpgradePlan({ tagName: params.tagName || tagObject.fullTagName, requestedPlan, domainConfig }) || v4Stamp.plan;
    const term = resolveNameAndPlanTerm({ basePublicData, duration, plan });

    const extraParams = {
        origin: tagObject.publicData.origin || "online",
        price:
            params.paymentMethod === "gift" ||
            params.paymentMethod === "coupon" ||
            params.paymentMethod === "whitelist" ||
            params.paymentMethod === "free"
                ? 0
                : price,
        paymentMethod: params.paymentMethod || undefined,
        duration: term.duration,
        registeredAt: basePublicData.registeredAt || tagObject.publicData.registeredAt || formatLeaseDate(),
        renewedAt: tagObject.publicData.type === "mainnet" ? formatLeaseDate() : undefined,
        expiresAt: term.leaseExpiresAt,
        planExpiresAt: term.planExpiresAt,
        type: "mainnet",
        hasPassword: tagObject.publicData.hasPassword,
        eventID: params.eventID || undefined,
        eventPrice: params.eventPrice || undefined,
        revenueCatOriginalTransactionId: params.revenueCatOriginalTransactionId || tagObject.publicData.revenueCatOriginalTransactionId || undefined,
        plan,
    };

    const metadata = {
        [storageKey]: tagObject.fullTagName,
        domain,
        extraParams: stampExtraParamsVersion(extraParams, encryptVersion),
    };

    if (tagObject.publicData.referralTagName) {
        metadata.referral = {
            tagName: tagObject.publicData.referralTagName,
            solanaAddress: tagObject.publicData.referralSolanaAddress,
        };

        metadata.referralTagName = metadata.referral.tagName;
        metadata.referral = JSON.stringify(metadata.referral);
    }

    const fitted = fitExtraParamsForPin(metadata.extraParams);
    metadata.extraParams = JSON.stringify(fitted.extraParams);
    const planTerm = term.planDuration
        ? {
              plan: fitted.planTerm?.plan || plan || null,
              planExpiresAt: fitted.planTerm?.planExpiresAt || term.planExpiresAt || null,
              paymentMethod: fitted.planTerm?.paymentMethod || params.paymentMethod || null,
              duration: term.planDuration,
          }
        : fitted.planTerm;

    return { metadata, fullTagName: tagObject.fullTagName, planTerm };
};

/**
 * Stamp `free` with the 100-year lease sentinel after a subscription expires.
 * @param {Object} params
 * @param {Object} tagObject
 * @param {Object} domainConfig
 */
const buildFreePlanRevertMetadata = (params, tagObject, domainConfig) => {
    const domain = params.domain || domainConfig.name;
    tagObject.fullTagName = getCanonicalMainnetName(params.tagName || tagObject.publicData.tagName || tagObject.publicData.zelfName, domain);

    const storageKey = domainConfig.getTagKey();
    const encryptVersion = resolveEncryptVersion(tagObject.publicData);

    const extraParams = {
        origin: tagObject.publicData.origin || "online",
        price: tagObject.publicData.price,
        duration: "1",
        registeredAt: tagObject.publicData.registeredAt || formatLeaseDate(),
        renewedAt: formatLeaseDate(),
        expiresAt: formatLeaseDate(FREE_EXPIRATION_YEARS, "year"),
        type: "mainnet",
        hasPassword: tagObject.publicData.hasPassword,
        eventID: params.eventID || undefined,
        revenueCatOriginalTransactionId: tagObject.publicData.revenueCatOriginalTransactionId || params.revenueCatOriginalTransactionId || undefined,
        plan: "free",
    };

    const metadata = {
        [storageKey]: tagObject.fullTagName,
        domain,
        extraParams: stampExtraParamsVersion(extraParams, encryptVersion),
    };

    const fitted = fitExtraParamsForPin(metadata.extraParams);
    metadata.extraParams = JSON.stringify(fitted.extraParams);

    return { metadata, fullTagName: tagObject.fullTagName, planTerm: null, clearPlanTerm: true };
};

/**
 * Plan switch with no time added (RevenueCat PRODUCT_CHANGE premium → unlimited).
 * Keeps price, duration, and expiresAt; stamps the new plan.
 * @param {Object} params
 * @param {Object} tagObject
 * @param {Object} domainConfig
 * @returns {{ metadata: Object, fullTagName: string }}
 */
const buildPlanChangeMetadata = (params, tagObject, domainConfig) => {
    const domain = params.domain || domainConfig.name;
    tagObject.fullTagName = getCanonicalMainnetName(params.tagName || tagObject.publicData.tagName || tagObject.publicData.zelfName, domain);

    const storageKey = domainConfig.getTagKey();
    const encryptVersion = resolveEncryptVersion(tagObject.publicData);

    const extraParams = {
        origin: tagObject.publicData.origin || "online",
        price: tagObject.publicData.price,
        duration: tagObject.publicData.duration,
        registeredAt: tagObject.publicData.registeredAt || formatLeaseDate(),
        renewedAt: formatLeaseDate(),
        expiresAt: tagObject.publicData.expiresAt,
        type: "mainnet",
        hasPassword: tagObject.publicData.hasPassword,
        eventID: params.eventID || undefined,
        revenueCatOriginalTransactionId: params.revenueCatOriginalTransactionId || tagObject.publicData.revenueCatOriginalTransactionId || undefined,
        plan: params.plan,
    };

    const metadata = {
        [storageKey]: tagObject.fullTagName,
        domain,
        extraParams: stampExtraParamsVersion(extraParams, encryptVersion),
    };

    const fitted = fitExtraParamsForPin(metadata.extraParams);
    metadata.extraParams = JSON.stringify(fitted.extraParams);

    return { metadata, fullTagName: tagObject.fullTagName, planTerm: fitted.planTerm };
};

/**
 * Referral for a checkout. The record's stored referral always wins (it was set at lease).
 * Otherwise an optional checkout `referralTagName` must be an existing, different Zelf ID
 * of the same domain. Its discount comes only from the license (`payment.whitelist`).
 * @returns {Promise<{ referralTagName: string, referralSolanaAddress: string }>}
 */
const resolveCheckoutReferral = async ({ tagName, domain, domainConfig, publicData = {}, referralTagName, authUser }) => {
    if (publicData.referralTagName) {
        return { referralTagName: publicData.referralTagName, referralSolanaAddress: publicData.referralSolanaAddress || "" };
    }

    if (!referralTagName) return { referralTagName: "", referralSolanaAddress: "" };

    const bare = `${referralTagName}`.trim().toLowerCase().split(".")[0];
    const fullName = `${bare}.${domain}`;

    if (!bare || bare === `${tagName}`.toLowerCase().split(".")[0]) throw new Error("409:invalid_referral");

    const ZelfIdModule = require("./zelf-id.module");
    const referrer = await ZelfIdModule._validateReferral(fullName, authUser, domainConfig);

    if (!referrer) throw new Error("404:referral_not_found");

    return { referralTagName: fullName, referralSolanaAddress: referrer.publicData?.solanaAddress || "" };
};

const getPaymentOptions = async (tagName, domain, duration, authUser, requestOptions = {}) => {
    const ZelfIdModule = require("./zelf-id.module");
    const domainConfig = getDomainConfig(domain);
    const tagData = await ZelfIdModule.searchTag({ tagName, domain, domainConfig }, authUser);

    if (tagData.available) throw new Error("404:tag_not_found");

    const tagObject = tagData.tagObject;
    const currentPlan = effectivePlan(tagObject.publicData, domainConfig);
    const currentDuration = normalizePaymentDuration(tagObject.publicData.planDuration || tagObject.publicData.duration);
    if (currentPlan === "unlimited" && currentDuration === "lifetime") {
        const error = new Error("409:already_lifetime");
        error.clientCode = "already_lifetime";
        error.clientMessage = "plan_not_upgradable";
        error.status = 409;
        throw error;
    }
    const requestedPlan = requestOptions.requestedPlan || requestOptions.plan;
    const normalizedDuration = normalizePaymentDuration(duration);
    require("./zelf-id-plan.module").assertPurchaseKeepsPaidValue({
        publicData: tagObject.publicData,
        requestedPlan,
        tagName,
        domainConfig,
    });
    // Price with the plan this payment stamps (premium by default for long names).
    // `getZelfIdPrice` without a plan read the Tags default table, so a long name
    // paid the default price and was still stamped premium.
    // Referral / coupon: the record's own referral wins; otherwise a checkout referral
    // (a license `payment.whitelist` entry is the coupon) is validated and priced from the license.
    const referral = await resolveCheckoutReferral({
        tagName,
        domain,
        domainConfig,
        publicData: tagObject.publicData,
        referralTagName: requestOptions.referralTagName,
        authUser,
    });
    const explicitPlan = `${requestedPlan || ""}`.trim().toLowerCase();
    const couponCode = `${requestOptions.coupon || ""}`.trim();
    // plan=free must stay a free quote. Checkout pricing would otherwise replace it with Premium.
    const keepFreeQuote = explicitPlan === "free" && Boolean(couponCode);
    let priceDetails;
    if (keepFreeQuote) {
        try {
            priceDetails = getZelfIdPrice({
                tagName,
                duration: normalizedDuration,
                referralTagName: "",
                domainConfig,
                requestedPlan: "free",
            });
        } catch (_error) {
            priceDetails = {
                price: 0,
                priceWithoutDiscount: 0,
                plan: "free",
                reward: 0,
                discount: 0,
                discountType: "percentage",
                allowedPlans: [],
            };
        }
        priceDetails = { ...priceDetails, plan: "free" };
    } else {
        priceDetails = getZelfIdCheckoutPrice({
            tagName,
            duration: normalizedDuration,
            referralTagName: referral.referralTagName,
            domainConfig,
            requestedPlan,
        });
    }
    const devAmountFraction = resolveTagPayBillableFraction({
        reducedFeeRequested: Boolean(requestOptions.reducedFeeRequested),
    });
    const listPriceUsd = priceDetails.priceWithoutDiscount ?? priceDetails.price;
    const { computeUpgradeCredit, priceAfterUpgradeCredit } = require("./zelf-id-upgrade-credit.module");
    const upgrade = keepFreeQuote
        ? { upgradeCreditUsd: 0 }
        : await computeUpgradeCredit({
              publicData: tagObject.publicData,
              tagName,
              domain,
              targetPlan: priceDetails.plan,
              listPriceUsd,
          });
    const upgradeCreditUsd = upgrade.upgradeCreditUsd;
    const priceAfterCredit = priceAfterUpgradeCredit(listPriceUsd, upgradeCreditUsd);
    let couponQuote = null;
    if (couponCode) {
        const Coupons = require("./zelf-ids-coupons.module");
        const bare = `${tagName}`.split(".")[0].toLowerCase();
        couponQuote = await Coupons.describeCoupon({
            code: couponCode,
            plan: keepFreeQuote ? "free" : priceDetails.plan,
            duration: normalizedDuration,
            zelfId: `${bare}.${String(domain || "").toLowerCase()}`,
            listPrice: priceAfterCredit,
        });
    }
    // A valid coupon replaces referral and dev-fee adjustments and applies after upgrade credit.
    // Credit is subtracted from the license list. A whitelist quote (price 0) stays 0.
    const rawBillable = couponQuote?.valid
        ? couponQuote.amountDue
        : upgradeCreditUsd > 0 && Number(priceDetails.price) !== 0
          ? devAmountFraction != null
              ? priceAfterCredit * devAmountFraction
              : priceAfterCredit
          : devAmountFraction != null
            ? priceDetails.price * devAmountFraction
            : priceDetails.price;
    const devScaledPositive = devAmountFraction != null && !couponQuote?.valid && Number(rawBillable) > 0;
    const billableUsdPrice = roundBillableUsdPrice(rawBillable, { keepPositive: devScaledPositive });
    const zelfPayCount = tagData.ipfs?.length || tagData.arweave?.length;

    const renewTagPayObject = await _fetchTagPayRecord(
        {
            tagName: `${tagData.tagName}.${domain}`,
            publicData: tagObject.publicData,
        },
        zelfPayCount,
        priceDetails,
        domainConfig
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

    const networks = domainConfig?.tags?.payment?.networks;
    const oldCurrencies = domainConfig?.tags?.payment?.currencies;
    const bscNetwork = networks?.bsc ?? networks?.binance;

    if (
        oldCurrencies?.includes("ETH") ||
        (networks?.ethereum?.enabled && networks?.ethereum?.nativeCurrency?.enabled && networks?.ethereum?.nativeCurrency?.code === "ETH")
    ) {
        prices.ETH = await calculateCryptoValue("ETH", billableUsdPrice);
    }

    if (
        oldCurrencies?.includes("SOL") ||
        (networks?.solana?.enabled && networks?.solana?.nativeCurrency?.enabled && networks?.solana?.nativeCurrency?.code === "SOL")
    ) {
        prices.SOL = await calculateCryptoValue("SOL", billableUsdPrice);
    }

    if (
        oldCurrencies?.includes("BTC") ||
        (networks?.bitcoin?.enabled && networks?.bitcoin?.nativeCurrency?.enabled && networks?.bitcoin?.nativeCurrency?.code === "BTC")
    ) {
        prices.BTC = await calculateCryptoValue("BTC", billableUsdPrice);
    }

    if (
        oldCurrencies?.includes("AVAX") ||
        (networks?.avalanche?.enabled && networks?.avalanche?.nativeCurrency?.enabled && networks?.avalanche?.nativeCurrency?.code === "AVAX")
    ) {
        prices.AVAX = await calculateCryptoValue("AVAX", billableUsdPrice);
    }

    if (oldCurrencies?.includes("BNB") || (bscNetwork?.enabled && bscNetwork?.nativeCurrency?.enabled && bscNetwork?.nativeCurrency?.code === "BNB")) {
        prices.BNB = await calculateCryptoValue("BNB", billableUsdPrice);
    }

    const polygonNativeCode = networks?.polygon?.nativeCurrency?.code;
    if (
        oldCurrencies?.includes("POL") ||
        (networks?.polygon?.enabled && networks?.polygon?.nativeCurrency?.enabled && (polygonNativeCode === "POL" || polygonNativeCode === "MATIC"))
    ) {
        prices.POL = await calculateCryptoValue("POL", billableUsdPrice);
    }

    if (
        oldCurrencies?.includes("BASE") ||
        (networks?.base?.enabled && networks?.base?.nativeCurrency?.enabled && networks?.base?.nativeCurrency?.code === "BASE")
    ) {
        prices.BASE = await calculateCryptoValue("ETH", billableUsdPrice);
    }

    if (networks?.blockdag?.enabled && networks?.blockdag?.nativeCurrency?.enabled && networks?.blockdag?.nativeCurrency?.code === "BDAG") {
        prices.BDAG = await calculateCryptoValue("BDAG", billableUsdPrice);
    }

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
        // Expiration this purchase would stamp (current `expiresAt` is unchanged above).
        newExpiresAt: keepFreeQuote
            ? tagObject.publicData.expiresAt
            : resolvePaidExpiresAt({ publicData: tagObject.publicData, duration: normalizedDuration }),
        initiatedAt: moment().unix(),
        ttl: moment().add("2", "hours").unix(),
        duration: normalizedDuration === "lifetime" ? "lifetime" : parseInt(normalizedDuration || 1),
        count: parseInt(renewTagPayObject.publicData?.count),
        publicData: renewTagPayObject.publicData,
        plan: keepFreeQuote
            ? "free"
            : resolveUpgradePlan({
                  tagName,
                  requestedPlan: requestedPlan || priceDetails.plan,
              }) ||
              resolveV4PaymentStamp({
                  tagName,
                  encryptVersion: resolveEncryptVersion(tagObject.publicData),
                  requestedPlan: requestedPlan || priceDetails.plan,
              }).plan,
        allowedPlans: priceDetails.allowedPlans,
        payment: {
            registeredAt: renewTagPayObject.publicData?.registeredAt,
            expiresAt: renewTagPayObject.publicData?.expiresAt,
            referralTagName: referral.referralTagName || undefined,
            referralSolanaAddress: referral.referralSolanaAddress || undefined,
        },
        referralTagName: referral.referralTagName || undefined,
        listPriceUsd,
        listPrice: listPriceUsd,
        upgradeCredit: upgradeCreditUsd,
        upgradeCreditUsd,
        upgradeTerm: upgrade.upgradeTerm || null,
        amountDue: roundBillableUsdPrice(billableUsdPrice),
        billableUsdPrice,
        reward: priceDetails.reward,
        discount: priceDetails.discount,
        discountType: priceDetails.discountType,
        // $0 after a license whitelist or a 100% plan coupon: confirm with no network (FREE), no Stripe, RevenueCat, or crypto.
        // A rejected plan=free coupon is not a $0 grant.
        freeCheckout: keepFreeQuote ? false : Number(billableUsdPrice) === 0,
    };

    if (couponQuote) {
        returnData.percentOff = couponQuote.percentOff;
        returnData.currency = couponQuote.currency;
        returnData.coupon = couponQuote.coupon;
    }

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

    attachEvmPayQuote({
        returnData,
        prices,
        nativePrice: prices.BNB,
        configBlock: config.bsc,
        versionPrefix: "ZELF_BSC_PAY_v1",
        expectedWeiFn: bnbExpectedWeiFromUsd,
        weiError: "expectedWei_bsc_non_positive",
        contractKey: "smartContractBSC",
        chainId: config.bsc.chainId,
        usdcAddr: config.bsc.tagPayUsdcAddress,
        usdtAddr: config.bsc.tagPayUsdtAddress,
        stableDecimals: 18,
        stableHumanDigits: 8,
        usdcPriceKey: "BSC_USDC",
        usdtPriceKey: "BSC_USDT",
        billableUsdPrice,
        devAmountFraction,
    });

    attachEvmPayQuote({
        returnData,
        prices,
        nativePrice: prices.ETH,
        configBlock: config.ethereum,
        versionPrefix: "ZELF_ETH_PAY_v1",
        expectedWeiFn: ethExpectedWeiFromUsd,
        weiError: "expectedWei_eth_non_positive",
        contractKey: "smartContractETH",
        chainId: config.ethereum.chainId,
        usdcAddr: config.ethereum.tagPayUsdcAddress,
        usdtAddr: config.ethereum.tagPayUsdtAddress,
        stableDecimals: 6,
        stableHumanDigits: 6,
        usdcPriceKey: "ETH_USDC",
        usdtPriceKey: "ETH_USDT",
        billableUsdPrice,
        devAmountFraction,
        deleteEthAddress: true,
    });

    attachEvmPayQuote({
        returnData,
        prices,
        nativePrice: prices.POL,
        configBlock: config.polygon,
        versionPrefix: "ZELF_POLYGON_PAY_v1",
        expectedWeiFn: polExpectedWeiFromUsd,
        weiError: "expectedWei_pol_non_positive",
        contractKey: "smartContractPOLYGON",
        chainId: config.polygon.chainId,
        usdcAddr: config.polygon.tagPayUsdcAddress,
        usdtAddr: config.polygon.tagPayUsdtAddress,
        stableDecimals: 6,
        stableHumanDigits: 6,
        usdcPriceKey: "POL_USDC",
        usdtPriceKey: "POL_USDT",
        billableUsdPrice,
        devAmountFraction,
        alignPolDisplay: true,
    });

    if (prices.POL && !returnData.smartContractPOLYGON) {
        const q = 10 ** POL_NATIVE_DISPLAY_DECIMALS;
        prices.POL.amountToSend = Math.round(prices.POL.amountToSend * q) / q;
    }

    attachEvmPayQuote({
        returnData,
        prices,
        nativePrice: prices.BASE,
        configBlock: config.base,
        versionPrefix: "ZELF_BASE_PAY_v1",
        expectedWeiFn: ethExpectedWeiFromUsd,
        weiError: "expectedWei_base_non_positive",
        contractKey: "smartContractBASE",
        chainId: config.base.chainId,
        usdcAddr: config.base.tagPayUsdcAddress,
        usdtAddr: config.base.tagPayUsdtAddress,
        stableDecimals: 6,
        stableHumanDigits: 6,
        usdcPriceKey: "BASE_USDC",
        usdtPriceKey: "BASE_USDT",
        billableUsdPrice,
        devAmountFraction,
        deleteEthAddress: true,
    });

    attachEvmPayQuote({
        returnData,
        prices,
        nativePrice: prices.BDAG,
        configBlock: config.blockdag,
        versionPrefix: "ZELF_BLOCKDAG_PAY_v1",
        expectedWeiFn: bdagExpectedWeiFromUsd,
        weiError: "expectedWei_bdag_non_positive",
        contractKey: "smartContractBDAG",
        chainId: config.blockdag.chainId,
        billableUsdPrice,
        devAmountFraction,
        deleteEthAddress: true,
    });

    const signedDataPrice = jwt.sign(returnData, config.JWT_SECRET);

    return {
        ...returnData,
        signedDataPrice,
    };
};

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
        } catch (_error) {
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

const storeInIPFS = async (tagObject, domainConfig, metadata) => {
    const fullName = tagObject.fullTagName;
    // Reject an over-long pin before any existing pin is removed.
    const pages = buildSearchablePinPages({
        reserved: metadata,
        addresses: tagObject.publicData,
        tagName: fullName,
    });

    const previousPrimaryId = tagObject.ipfsId || tagObject.id;
    const previousCid = tagObject.cid || tagObject.ipfsHash || tagObject.ipfs?.cid || tagObject.ipfs?.ipfsHash;
    const previousSiblingIds = (await TagsIpfsModule.listContinuationSiblingPinIds(fullName)) || [];

    tagObject.ipfs = await TagsIpfsModule.insertSearchablePins(
        {
            base64: tagObject.zelfProofQRCode,
            name: fullName,
            reserved: metadata,
            addresses: tagObject.publicData,
            pinIt: true,
        },
        { pro: true }
    );

    const uploadedId = tagObject.ipfs?.id != null ? String(tagObject.ipfs.id) : "";
    const uploadedCid = String(tagObject.ipfs?.cid || tagObject.ipfs?.ipfsHash || tagObject.ipfs?.ipfs_pin_hash || "");
    const samePin =
        (previousPrimaryId && uploadedId && String(previousPrimaryId) === uploadedId) ||
        (previousCid && uploadedCid && String(previousCid) === uploadedCid) ||
        tagObject.ipfs?.duplicated === true ||
        tagObject.ipfs?.is_duplicate === true ||
        tagObject.ipfs?.saved === false;
    if (samePin) {
        const pinId = uploadedId || (previousPrimaryId != null ? String(previousPrimaryId) : "");
        if (pinId) tagObject.ipfs = await TagsIpfsModule.updateSearchablePinKeyvalues(pinId, pages.primary.keyvalues);
    }

    const keptId = tagObject.ipfs?.id != null ? String(tagObject.ipfs.id) : uploadedId;
    const staleIds = [
        ...new Set(
            [previousPrimaryId, ...previousSiblingIds].filter((id) => id != null && String(id) !== "" && String(id) !== keptId).map(String)
        ),
    ];
    if (!samePin && staleIds.length) await TagsIpfsModule.deleteFiles(staleIds);

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
    resolveCheckoutReferral,
    buildMetadata,
    buildFreePlanRevertMetadata,
    buildPlanChangeMetadata,
    getPaymentOptions,
    isTagPayReducedFeeClientHeaderHonored,
    ensureZelfProofQRCode,
    storeInIPFS,
    storeInArweave,
};
