const config = require("../../../Core/config");
const NodeCache = require("node-cache");
const { getAddress } = require("ethers");
const jwt = require("jsonwebtoken");
const moment = require("moment");
const { searchTag } = require("./tags.module");
const { getDomainConfig } = require("../config/supported-domains");
const { normalizeTagPayTxHash, verifyAvalancheZelfTagPayTx } = require("./avalanche-tag-pay-verify.module");
const { verifyBscZelfTagPayTx } = require("./bsc-tag-pay-verify.module");
const { verifyEthZelfTagPayTx } = require("./eth-tag-pay-verify.module");
const { verifyPolygonZelfTagPayTx } = require("./polygon-tag-pay-verify.module");
const { verifyBaseZelfTagPayTx } = require("./base-tag-pay-verify.module");
const { verifyBlockdagZelfTagPayTx } = require("./blockdag-tag-pay-verify.module");

const scPayTxCache = new NodeCache({ stdTTL: 172800, maxKeys: 50000, useClones: false });

const throwPaymentConfirmationTagNotFound = (tagName, domain) => {
    const fullTag = `${tagName}.${domain}`;
    console.warn("[payment_confirmation] tag_not_found", { tagName, domain, fullTag });
    const err = new Error("404:tag_not_found");
    err.clientCode = "tag_not_found";
    err.clientMessage = "Tag not found or not indexed";
    throw err;
};

/** Years to add for renewal; align with extend-license style lifetime handling. */
function scLicenseExtensionYears(durationRaw) {
    if (durationRaw === "lifetime" || durationRaw === 999 || durationRaw === "999") return 100;
    const n = Number(durationRaw);
    return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Same expiry math as tags-payment `buildMetadata` extraParams.expiresAt. */
function computeScLicenseExtension(currentExpiresAt, durationRaw) {
    const years = scLicenseExtensionYears(durationRaw);
    const previousExpiresAt = currentExpiresAt;
    const newExpiresAt = moment(currentExpiresAt).add(years, "year").format("YYYY-MM-DD HH:mm:ss");

    return { previousExpiresAt, newExpiresAt };
}

// --- JWT `smartContractAVAX`: native AVAX vs USDC (ZelfAvalanchePay) ---

/** True when JWT carries a positive native wei amount for `pay(...)`. */
function smartContractAvaxHasValidNativeWei(sc) {
    if (sc?.expectedWei == null || String(sc.expectedWei).trim() === "") return false;
    try {
        return BigInt(sc.expectedWei) > 0n;
    } catch {
        return false;
    }
}

/** True when JWT carries USDC token + positive atomic amount for `payUsdc(...)`. */
function smartContractAvaxHasValidUsdcPayload(sc) {
    if (!sc?.usdc?.tokenAddress) return false;
    if (sc.usdc.expectedAmount == null || String(sc.usdc.expectedAmount).trim() === "") return false;
    try {
        return BigInt(sc.usdc.expectedAmount) > 0n;
    } catch {
        return false;
    }
}

/**
 * @param {object | undefined} sc - tokenDecoded.smartContractAVAX
 * @returns {{ hasNativeWei: boolean, hasUsdcPayload: boolean }}
 */
function assertSmartContractAvaxPresent(sc) {
    const hasNativeWei = smartContractAvaxHasValidNativeWei(sc);
    const hasUsdcPayload = smartContractAvaxHasValidUsdcPayload(sc);

    if (!sc?.paymentId || sc?.chainId == null || (!hasNativeWei && !hasUsdcPayload)) {
        throw new Error("409:smart_contract_avax_not_in_token");
    }

    return { hasNativeWei, hasUsdcPayload };
}

// --- JWT `smartContractBSC`: native BNB vs USDC / USDT (ZelfBscPay) ---

function smartContractBscHasValidNativeWei(sc) {
    if (sc?.expectedWei == null || String(sc.expectedWei).trim() === "") return false;
    try {
        return BigInt(sc.expectedWei) > 0n;
    } catch {
        return false;
    }
}

function smartContractBscHasValidUsdcPayload(sc) {
    if (!sc?.usdc?.tokenAddress) return false;
    if (sc.usdc.expectedAmount == null || String(sc.usdc.expectedAmount).trim() === "") return false;
    try {
        return BigInt(sc.usdc.expectedAmount) > 0n;
    } catch {
        return false;
    }
}

function smartContractBscHasValidUsdtPayload(sc) {
    if (!sc?.usdt?.tokenAddress) return false;
    if (sc.usdt.expectedAmount == null || String(sc.usdt.expectedAmount).trim() === "") return false;
    try {
        return BigInt(sc.usdt.expectedAmount) > 0n;
    } catch {
        return false;
    }
}

/**
 * @param {object | undefined} sc - tokenDecoded.smartContractBSC
 */
function assertSmartContractBscPresent(sc) {
    const hasNativeWei = smartContractBscHasValidNativeWei(sc);
    const hasUsdcPayload = smartContractBscHasValidUsdcPayload(sc);
    const hasUsdtPayload = smartContractBscHasValidUsdtPayload(sc);

    if (!sc?.paymentId || sc?.chainId == null || (!hasNativeWei && !hasUsdcPayload && !hasUsdtPayload)) {
        throw new Error("409:smart_contract_bsc_not_in_token");
    }

    return { hasNativeWei, hasUsdcPayload, hasUsdtPayload };
}

// --- JWT `smartContractETH`: native ETH vs USDC / USDT (ZelfEthPay) ---

function smartContractEthHasValidNativeWei(sc) {
    if (sc?.expectedWei == null || String(sc.expectedWei).trim() === "") return false;
    try {
        return BigInt(sc.expectedWei) > 0n;
    } catch {
        return false;
    }
}

function smartContractEthHasValidUsdcPayload(sc) {
    if (!sc?.usdc?.tokenAddress) return false;
    if (sc.usdc.expectedAmount == null || String(sc.usdc.expectedAmount).trim() === "") return false;
    try {
        return BigInt(sc.usdc.expectedAmount) > 0n;
    } catch {
        return false;
    }
}

function smartContractEthHasValidUsdtPayload(sc) {
    if (!sc?.usdt?.tokenAddress) return false;
    if (sc.usdt.expectedAmount == null || String(sc.usdt.expectedAmount).trim() === "") return false;
    try {
        return BigInt(sc.usdt.expectedAmount) > 0n;
    } catch {
        return false;
    }
}

function assertSmartContractEthPresent(sc) {
    const hasNativeWei = smartContractEthHasValidNativeWei(sc);
    const hasUsdcPayload = smartContractEthHasValidUsdcPayload(sc);
    const hasUsdtPayload = smartContractEthHasValidUsdtPayload(sc);

    if (!sc?.paymentId || sc?.chainId == null || (!hasNativeWei && !hasUsdcPayload && !hasUsdtPayload)) {
        throw new Error("409:smart_contract_eth_not_in_token");
    }

    return { hasNativeWei, hasUsdcPayload, hasUsdtPayload };
}

// --- JWT `smartContractPOLYGON`: native POL vs USDC / USDT (ZelfPolygonPay) ---

function smartContractPolygonHasValidNativeWei(sc) {
    if (sc?.expectedWei == null || String(sc.expectedWei).trim() === "") return false;
    try {
        return BigInt(sc.expectedWei) > 0n;
    } catch {
        return false;
    }
}

function smartContractPolygonHasValidUsdcPayload(sc) {
    if (!sc?.usdc?.tokenAddress) return false;
    if (sc.usdc.expectedAmount == null || String(sc.usdc.expectedAmount).trim() === "") return false;
    try {
        return BigInt(sc.usdc.expectedAmount) > 0n;
    } catch {
        return false;
    }
}

function smartContractPolygonHasValidUsdtPayload(sc) {
    if (!sc?.usdt?.tokenAddress) return false;
    if (sc.usdt.expectedAmount == null || String(sc.usdt.expectedAmount).trim() === "") return false;
    try {
        return BigInt(sc.usdt.expectedAmount) > 0n;
    } catch {
        return false;
    }
}

function assertSmartContractPolygonPresent(sc) {
    const hasNativeWei = smartContractPolygonHasValidNativeWei(sc);
    const hasUsdcPayload = smartContractPolygonHasValidUsdcPayload(sc);
    const hasUsdtPayload = smartContractPolygonHasValidUsdtPayload(sc);

    if (!sc?.paymentId || sc?.chainId == null || (!hasNativeWei && !hasUsdcPayload && !hasUsdtPayload)) {
        throw new Error("409:smart_contract_polygon_not_in_token");
    }

    return { hasNativeWei, hasUsdcPayload, hasUsdtPayload };
}

// --- JWT `smartContractBASE`: native ETH on Base vs USDC / USDT (ZelfBasePay) ---

function smartContractBaseHasValidNativeWei(sc) {
    if (sc?.expectedWei == null || String(sc.expectedWei).trim() === "") return false;
    try {
        return BigInt(sc.expectedWei) > 0n;
    } catch {
        return false;
    }
}

function smartContractBaseHasValidUsdcPayload(sc) {
    if (!sc?.usdc?.tokenAddress) return false;
    if (sc.usdc.expectedAmount == null || String(sc.usdc.expectedAmount).trim() === "") return false;
    try {
        return BigInt(sc.usdc.expectedAmount) > 0n;
    } catch {
        return false;
    }
}

function smartContractBaseHasValidUsdtPayload(sc) {
    if (!sc?.usdt?.tokenAddress) return false;
    if (sc.usdt.expectedAmount == null || String(sc.usdt.expectedAmount).trim() === "") return false;
    try {
        return BigInt(sc.usdt.expectedAmount) > 0n;
    } catch {
        return false;
    }
}

function assertSmartContractBasePresent(sc) {
    const hasNativeWei = smartContractBaseHasValidNativeWei(sc);
    const hasUsdcPayload = smartContractBaseHasValidUsdcPayload(sc);
    const hasUsdtPayload = smartContractBaseHasValidUsdtPayload(sc);

    if (!sc?.paymentId || sc?.chainId == null || (!hasNativeWei && !hasUsdcPayload && !hasUsdtPayload)) {
        throw new Error("409:smart_contract_base_not_in_token");
    }

    return { hasNativeWei, hasUsdcPayload, hasUsdtPayload };
}

// --- JWT `smartContractBDAG`: native BDAG only (ZelfBlockDagPay) ---

function smartContractBdagHasValidNativeWei(sc) {
    if (sc?.expectedWei == null || String(sc.expectedWei).trim() === "") return false;
    try {
        return BigInt(sc.expectedWei) > 0n;
    } catch {
        return false;
    }
}

function assertSmartContractBdagPresent(sc) {
    const hasNativeWei = smartContractBdagHasValidNativeWei(sc);
    if (!sc?.paymentId || sc?.chainId == null || !hasNativeWei) {
        throw new Error("409:smart_contract_bdag_not_in_token");
    }
    return { hasNativeWei };
}

// --- Orchestration helpers ---

function decodeTagPayToken(tagName, domain, token) {
    const tokenDecoded = jwt.verify(token, config.JWT_SECRET);
    const domainConfig = getDomainConfig(domain);

    if (!tokenDecoded?.tagName || !tokenDecoded?.tagPayName) throw new Error("401:tag_not_authenticated");
    if (tokenDecoded.tagName !== `${tagName}.${domain}`) throw new Error("403:tag_not_owned");

    return { tokenDecoded, domainConfig };
}

/**
 * @returns {{ expectedContract: string, normalizedHash: string }}
 */
function resolveAvalancheContractAndTxHash(sc, txHash) {
    if (!config.avalanche.tagPayContractAddress) throw new Error("500:tag_pay_contract_not_configured");

    const expectedContract = getAddress(config.avalanche.tagPayContractAddress);

    if (Number(sc.chainId) !== Number(config.avalanche.chainId)) throw new Error("409:chain_id_mismatch");

    const normalizedHash = normalizeTagPayTxHash(txHash);
    if (!normalizedHash) throw new Error("409:invalid_tx_hash");

    return { expectedContract, normalizedHash };
}

/**
 * @returns {{ expectedContract: string, normalizedHash: string }}
 */
function resolveBscContractAndTxHash(sc, txHash) {
    if (!config.bsc.tagPayContractAddress) throw new Error("500:bsc_tag_pay_contract_not_configured");

    const expectedContract = getAddress(config.bsc.tagPayContractAddress);

    if (Number(sc.chainId) !== Number(config.bsc.chainId)) throw new Error("409:chain_id_mismatch");

    const normalizedHash = normalizeTagPayTxHash(txHash);
    if (!normalizedHash) throw new Error("409:invalid_tx_hash");

    return { expectedContract, normalizedHash };
}

/**
 * @returns {{ expectedContract: string, normalizedHash: string }}
 */
function resolveEthContractAndTxHash(sc, txHash) {
    if (!config.ethereum.tagPayContractAddress) throw new Error("500:eth_tag_pay_contract_not_configured");

    const expectedContract = getAddress(config.ethereum.tagPayContractAddress);

    if (Number(sc.chainId) !== Number(config.ethereum.chainId)) throw new Error("409:chain_id_mismatch");

    const normalizedHash = normalizeTagPayTxHash(txHash);
    if (!normalizedHash) throw new Error("409:invalid_tx_hash");

    return { expectedContract, normalizedHash };
}

/**
 * @returns {{ expectedContract: string, normalizedHash: string }}
 */
function resolvePolygonContractAndTxHash(sc, txHash) {
    if (!config.polygon.tagPayContractAddress) throw new Error("500:polygon_tag_pay_contract_not_configured");

    const expectedContract = getAddress(config.polygon.tagPayContractAddress);

    if (Number(sc.chainId) !== Number(config.polygon.chainId)) throw new Error("409:chain_id_mismatch");

    const normalizedHash = normalizeTagPayTxHash(txHash);
    if (!normalizedHash) throw new Error("409:invalid_tx_hash");

    return { expectedContract, normalizedHash };
}

/**
 * @returns {{ expectedContract: string, normalizedHash: string }}
 */
function resolveBaseContractAndTxHash(sc, txHash) {
    if (!config.base.tagPayContractAddress) throw new Error("500:base_tag_pay_contract_not_configured");

    const expectedContract = getAddress(config.base.tagPayContractAddress);

    if (Number(sc.chainId) !== Number(config.base.chainId)) throw new Error("409:chain_id_mismatch");

    const normalizedHash = normalizeTagPayTxHash(txHash);
    if (!normalizedHash) throw new Error("409:invalid_tx_hash");

    return { expectedContract, normalizedHash };
}

/**
 * @returns {{ expectedContract: string, normalizedHash: string }}
 */
function resolveBlockdagContractAndTxHash(sc, txHash) {
    if (!config.blockdag.tagPayContractAddress) throw new Error("500:blockdag_tag_pay_contract_not_configured");

    const expectedContract = getAddress(config.blockdag.tagPayContractAddress);

    if (Number(sc.chainId) !== Number(config.blockdag.chainId)) throw new Error("409:chain_id_mismatch");

    const normalizedHash = normalizeTagPayTxHash(txHash);
    if (!normalizedHash) throw new Error("409:invalid_tx_hash");

    return { expectedContract, normalizedHash };
}

function scPayCacheKey(normalizedHash) {
    return `scpay_tx_${normalizedHash}`;
}

function readScPayCache(cacheKey, sc, tagNameFull) {
    const cached = scPayTxCache.get(cacheKey);
    if (cached && cached.paymentId === sc.paymentId && cached.tagName === tagNameFull) return cached.body;
    return null;
}

function writeScPayCache(cacheKey, sc, tagNameFull, body) {
    scPayTxCache.set(cacheKey, { paymentId: sc.paymentId, tagName: tagNameFull, body });
}

function renewalShortCircuitFlags(tagObject, tokenDecoded) {
    const initiatedAt = tokenDecoded.initiatedAt ? moment.unix(tokenDecoded.initiatedAt) : null;
    const renewedAtCondition = Boolean(
        tagObject.publicData.renewedAt && initiatedAt && moment(tagObject.publicData.renewedAt).isAfter(initiatedAt),
    );
    const registeredAtCondition = Boolean(
        tokenDecoded.initiatedAt && moment(tagObject.publicData.registeredAt).isAfter(initiatedAt),
    );
    return { renewedAtCondition, registeredAtCondition };
}

function buildSmartContractPaymentConfirmation({ payMode, eventAmount, amountReceivedHuman, normalizedHash }) {
    return {
        confirmed: true,
        amountReceived: amountReceivedHuman,
        amountWei: eventAmount.toString(),
        payAsset: payMode,
        txHash: normalizedHash,
        checkedFactor: "smart_contract_event",
    };
}

async function verifyAvalancheChainOrFail({
    normalizedHash,
    expectedContract,
    sc,
    hasNativeWei,
    hasUsdcPayload,
    tokenDecoded,
}) {
    const rpcUrl = config.avalanche.rpcUrl;
    if (!rpcUrl) throw new Error("500:avalanche_rpc_not_configured");

    const confirmations = config.avalanche.tagPayConfirmations || 1;

    return verifyAvalancheZelfTagPayTx({
        normalizedHash,
        expectedContract,
        chainId: config.avalanche.chainId,
        rpcUrl,
        confirmations,
        sc,
        hasNativeWei,
        hasUsdcPayload,
        tagNameFull: tokenDecoded.tagName,
        prices: tokenDecoded.prices,
        tagPayUsdcAddress: config.avalanche.tagPayUsdcAddress,
    });
}

async function verifyBscChainOrFail({
    normalizedHash,
    expectedContract,
    sc,
    hasNativeWei,
    hasUsdcPayload,
    hasUsdtPayload,
    tokenDecoded,
}) {
    const rpcUrl = config.bsc.rpcUrl;
    if (!rpcUrl) throw new Error("500:bsc_rpc_not_configured");

    const confirmations = config.bsc.tagPayConfirmations || 1;

    return verifyBscZelfTagPayTx({
        normalizedHash,
        expectedContract,
        chainId: config.bsc.chainId,
        rpcUrl,
        confirmations,
        sc,
        hasNativeWei,
        hasUsdcPayload,
        hasUsdtPayload,
        tagNameFull: tokenDecoded.tagName,
        prices: tokenDecoded.prices,
        tagPayUsdcAddress: config.bsc.tagPayUsdcAddress,
        tagPayUsdtAddress: config.bsc.tagPayUsdtAddress,
    });
}

async function verifyEthChainOrFail({
    normalizedHash,
    expectedContract,
    sc,
    hasNativeWei,
    hasUsdcPayload,
    hasUsdtPayload,
    tokenDecoded,
}) {
    const rpcUrl = config.ethereum.rpcUrl;
    if (!rpcUrl) throw new Error("500:ethereum_rpc_not_configured");

    const confirmations = config.ethereum.tagPayConfirmations || 1;

    return verifyEthZelfTagPayTx({
        normalizedHash,
        expectedContract,
        chainId: config.ethereum.chainId,
        rpcUrl,
        confirmations,
        sc,
        hasNativeWei,
        hasUsdcPayload,
        hasUsdtPayload,
        tagNameFull: tokenDecoded.tagName,
        prices: tokenDecoded.prices,
        tagPayUsdcAddress: config.ethereum.tagPayUsdcAddress,
        tagPayUsdtAddress: config.ethereum.tagPayUsdtAddress,
    });
}

async function verifyPolygonChainOrFail({
    normalizedHash,
    expectedContract,
    sc,
    hasNativeWei,
    hasUsdcPayload,
    hasUsdtPayload,
    tokenDecoded,
}) {
    const rpcUrl = config.polygon.rpcUrl;
    if (!rpcUrl) throw new Error("500:polygon_rpc_not_configured");

    const confirmations = config.polygon.tagPayConfirmations || 1;

    return verifyPolygonZelfTagPayTx({
        normalizedHash,
        expectedContract,
        chainId: config.polygon.chainId,
        rpcUrl,
        confirmations,
        sc,
        hasNativeWei,
        hasUsdcPayload,
        hasUsdtPayload,
        tagNameFull: tokenDecoded.tagName,
        prices: tokenDecoded.prices,
        tagPayUsdcAddress: config.polygon.tagPayUsdcAddress,
        tagPayUsdtAddress: config.polygon.tagPayUsdtAddress,
    });
}

async function verifyBaseChainOrFail({
    normalizedHash,
    expectedContract,
    sc,
    hasNativeWei,
    hasUsdcPayload,
    hasUsdtPayload,
    tokenDecoded,
}) {
    const rpcUrl = config.base.rpcUrl;
    if (!rpcUrl) throw new Error("500:base_rpc_not_configured");

    const confirmations = config.base.tagPayConfirmations || 1;

    return verifyBaseZelfTagPayTx({
        normalizedHash,
        expectedContract,
        chainId: config.base.chainId,
        rpcUrl,
        confirmations,
        sc,
        hasNativeWei,
        hasUsdcPayload,
        hasUsdtPayload,
        tagNameFull: tokenDecoded.tagName,
        prices: tokenDecoded.prices,
        tagPayUsdcAddress: config.base.tagPayUsdcAddress,
        tagPayUsdtAddress: config.base.tagPayUsdtAddress,
    });
}

async function verifyBlockdagChainOrFail({ normalizedHash, expectedContract, sc, hasNativeWei, tokenDecoded }) {
    const rpcUrl = config.blockdag.rpcUrl;
    if (!rpcUrl) throw new Error("500:blockdag_rpc_not_configured");

    const confirmations = config.blockdag.tagPayConfirmations || 1;

    return verifyBlockdagZelfTagPayTx({
        normalizedHash,
        expectedContract,
        chainId: config.blockdag.chainId,
        rpcUrl,
        confirmations,
        sc,
        hasNativeWei,
        tagNameFull: tokenDecoded.tagName,
        prices: tokenDecoded.prices,
    });
}

const resolveSmartContractPaymentNetwork = (tokenDecoded = {}) => {
    if (tokenDecoded.smartContractAVAX) return "AVAX";
    if (tokenDecoded.smartContractBSC) return "BNB";
    if (tokenDecoded.smartContractETH) return "ETH";
    if (tokenDecoded.smartContractPOLYGON) return "POL";
    if (tokenDecoded.smartContractBASE) return "BASE";
    if (tokenDecoded.smartContractBDAG) return "BDAG";
    return "smart_contract";
};

async function extendTagAfterSmartContractPay({ domainConfig, domain, tokenDecoded, amountToPay, tagObject, txHash, paymentNetwork }) {
    const resolvedNetwork = paymentNetwork || resolveSmartContractPaymentNetwork(tokenDecoded);
    const { resolveEncryptVersion } = require("./tags-addresses.module");
    const encryptVersion = resolveEncryptVersion(tagObject.publicData);
    const isZelfId =
        Number(encryptVersion) === 4 ||
        Boolean(tokenDecoded.plan) ||
        tagObject.publicData?.plan === "free" ||
        tagObject.publicData?.plan === "premium" ||
        tagObject.publicData?.plan === "unlimited";

    const addDurationToTag = isZelfId
        ? require("../../ZelfID/modules/my-zelf-id.module").addDurationToTag
        : require("./my-tags.module").addDurationToTag;

    let claimed = null;
    if (isZelfId && tokenDecoded.coupon?.valid === true && tokenDecoded.coupon.code) {
        const Coupons = require("../../ZelfID/modules/zelf-ids-coupons.module");
        try {
            claimed = await Coupons.claimForGrant({
                code: tokenDecoded.coupon.code,
                zelfId: String(tokenDecoded.tagName || "").toLowerCase(),
                plan: tokenDecoded.plan,
                duration: tokenDecoded.duration,
                domainConfig,
                tagName: tagObject.publicData[domainConfig.getTagKey()].split(".")[0],
                signedAmount: tokenDecoded.amountDue ?? tokenDecoded.billableUsdPrice ?? tokenDecoded.prices?.[resolvedNetwork]?.price,
            });
        } catch (error) {
            const { recordPurchaseManualReview } = require("../../ZelfID/modules/zelf-id-purchase-manual-review.module");
            await recordPurchaseManualReview({
                tagName: tagObject.publicData[domainConfig.getTagKey()].split(".")[0],
                domain,
                plan: tokenDecoded.plan,
                duration: tokenDecoded.duration,
                price: amountToPay,
                billableUsdPrice: tokenDecoded.amountDue ?? tokenDecoded.prices?.[resolvedNetwork]?.price,
                cryptoSymbol: resolvedNetwork,
                cryptoAmount: amountToPay,
                source: resolvedNetwork,
                violationCode: error.clientCode || "coupon_invalid",
                txHash,
                paymentNetwork: resolvedNetwork,
                paymentInitiatedAt: tokenDecoded.initiatedAt,
                tagObject,
                domainConfig,
            });
            throw error;
        }
    }

    let extension;
    try {
        extension = await addDurationToTag(
            {
                tagName: tagObject.publicData[domainConfig.getTagKey()].split(".")[0],
                price: amountToPay,
                domain,
                duration: tokenDecoded.duration || 1,
                plan: tokenDecoded.plan,
                domainConfig,
                paymentCaptured: isZelfId,
                paymentSource: isZelfId ? resolvedNetwork : undefined,
                paymentNetwork: resolvedNetwork,
                txHash: isZelfId ? txHash : undefined,
                billableUsdPrice: tokenDecoded.prices?.[resolvedNetwork]?.price,
                cryptoSymbol: resolvedNetwork,
                cryptoAmount: amountToPay,
                paymentInitiatedAt: tokenDecoded.initiatedAt,
                couponId: claimed?.couponId,
            },
            tagObject,
        );
    } catch (error) {
        if (claimed) {
            const Coupons = require("../../ZelfID/modules/zelf-ids-coupons.module");
            await Coupons.releaseRedemption(claimed);
        }
        throw error;
    }

    if (isZelfId && extension?.manualReview) {
        if (claimed) {
            const Coupons = require("../../ZelfID/modules/zelf-ids-coupons.module");
            await Coupons.releaseRedemption(claimed);
        }
        return extension;
    }
}

async function verifyAvalancheSmartContractPayment(tagName, domain, token, txHash) {
    const { tokenDecoded, domainConfig } = decodeTagPayToken(tagName, domain, token);

    const sc = tokenDecoded.smartContractAVAX;

    const { hasNativeWei, hasUsdcPayload } = assertSmartContractAvaxPresent(sc);

    const { expectedContract, normalizedHash } = resolveAvalancheContractAndTxHash(sc, txHash);
    const cacheKey = scPayCacheKey(normalizedHash);

    const cachedBody = readScPayCache(cacheKey, sc, tokenDecoded.tagName);
    if (cachedBody) return cachedBody;

    const tagData = await searchTag({ tagName, domain }, {});
    if (tagData.available) throwPaymentConfirmationTagNotFound(tagName, domain);

    const tagObject = tagData.tagObject;
    const { renewedAtCondition, registeredAtCondition } = renewalShortCircuitFlags(tagObject, tokenDecoded);

    const onChain = await verifyAvalancheChainOrFail({
        normalizedHash,
        expectedContract,
        sc,
        hasNativeWei,
        hasUsdcPayload,
        tokenDecoded,
    });

    if (!onChain.ok) return onChain.body;

    const { payMode, eventAmount, amountReceivedHuman, amountToPay } = onChain;
    const paymentConfirmation = buildSmartContractPaymentConfirmation({
        payMode,
        eventAmount,
        amountReceivedHuman,
        normalizedHash,
    });

    if (renewedAtCondition || registeredAtCondition) {
        const result = {
            cache: true,
            confirmed: true,
            amountReceived: String(amountReceivedHuman),
            paymentConfirmation,
            publicData: tagObject.publicData,
            reward: "pending_to_code",
            licenseExtension: null,
        };
        writeScPayCache(cacheKey, sc, tokenDecoded.tagName, result);
        return result;
    }

    const licenseExtension = computeScLicenseExtension(tagObject.publicData.expiresAt, tokenDecoded.duration);

    await extendTagAfterSmartContractPay({ domainConfig, domain, tokenDecoded, amountToPay, tagObject, txHash: normalizedHash });

    const result = {
        tagObject,
        confirmed: true,
        amountReceived: String(amountReceivedHuman),
        paymentConfirmation,
        licenseExtension,
    };

    writeScPayCache(cacheKey, sc, tokenDecoded.tagName, result);

    return result;
}

async function verifyBscSmartContractPayment(tagName, domain, token, txHash) {
    const { tokenDecoded, domainConfig } = decodeTagPayToken(tagName, domain, token);

    const sc = tokenDecoded.smartContractBSC;

    const { hasNativeWei, hasUsdcPayload, hasUsdtPayload } = assertSmartContractBscPresent(sc);

    const { expectedContract, normalizedHash } = resolveBscContractAndTxHash(sc, txHash);
    const cacheKey = scPayCacheKey(normalizedHash);

    const cachedBody = readScPayCache(cacheKey, sc, tokenDecoded.tagName);
    if (cachedBody) return cachedBody;

    const tagData = await searchTag({ tagName, domain }, {});
    if (tagData.available) throwPaymentConfirmationTagNotFound(tagName, domain);

    const tagObject = tagData.tagObject;
    const { renewedAtCondition, registeredAtCondition } = renewalShortCircuitFlags(tagObject, tokenDecoded);

    const onChain = await verifyBscChainOrFail({
        normalizedHash,
        expectedContract,
        sc,
        hasNativeWei,
        hasUsdcPayload,
        hasUsdtPayload,
        tokenDecoded,
    });

    if (!onChain.ok) return onChain.body;

    const { payMode, eventAmount, amountReceivedHuman, amountToPay } = onChain;
    const paymentConfirmation = buildSmartContractPaymentConfirmation({
        payMode,
        eventAmount,
        amountReceivedHuman,
        normalizedHash,
    });

    if (renewedAtCondition || registeredAtCondition) {
        const result = {
            cache: true,
            confirmed: true,
            amountReceived: String(amountReceivedHuman),
            paymentConfirmation,
            publicData: tagObject.publicData,
            reward: "pending_to_code",
            licenseExtension: null,
        };
        writeScPayCache(cacheKey, sc, tokenDecoded.tagName, result);
        return result;
    }

    const licenseExtension = computeScLicenseExtension(tagObject.publicData.expiresAt, tokenDecoded.duration);

    await extendTagAfterSmartContractPay({ domainConfig, domain, tokenDecoded, amountToPay, tagObject, txHash: normalizedHash });

    const result = {
        tagObject,
        confirmed: true,
        amountReceived: String(amountReceivedHuman),
        paymentConfirmation,
        licenseExtension,
    };

    writeScPayCache(cacheKey, sc, tokenDecoded.tagName, result);

    return result;
}

async function verifyEthSmartContractPayment(tagName, domain, token, txHash) {
    const { tokenDecoded, domainConfig } = decodeTagPayToken(tagName, domain, token);

    const sc = tokenDecoded.smartContractETH;

    const { hasNativeWei, hasUsdcPayload, hasUsdtPayload } = assertSmartContractEthPresent(sc);

    const { expectedContract, normalizedHash } = resolveEthContractAndTxHash(sc, txHash);
    const cacheKey = scPayCacheKey(normalizedHash);

    const cachedBody = readScPayCache(cacheKey, sc, tokenDecoded.tagName);
    if (cachedBody) return cachedBody;

    const tagData = await searchTag({ tagName, domain }, {});
    if (tagData.available) throwPaymentConfirmationTagNotFound(tagName, domain);

    const tagObject = tagData.tagObject;
    const { renewedAtCondition, registeredAtCondition } = renewalShortCircuitFlags(tagObject, tokenDecoded);

    const onChain = await verifyEthChainOrFail({
        normalizedHash,
        expectedContract,
        sc,
        hasNativeWei,
        hasUsdcPayload,
        hasUsdtPayload,
        tokenDecoded,
    });

    if (!onChain.ok) return onChain.body;

    const { payMode, eventAmount, amountReceivedHuman, amountToPay } = onChain;
    const paymentConfirmation = buildSmartContractPaymentConfirmation({
        payMode,
        eventAmount,
        amountReceivedHuman,
        normalizedHash,
    });

    if (renewedAtCondition || registeredAtCondition) {
        const result = {
            cache: true,
            confirmed: true,
            amountReceived: String(amountReceivedHuman),
            paymentConfirmation,
            publicData: tagObject.publicData,
            reward: "pending_to_code",
            licenseExtension: null,
        };
        writeScPayCache(cacheKey, sc, tokenDecoded.tagName, result);
        return result;
    }

    const licenseExtension = computeScLicenseExtension(tagObject.publicData.expiresAt, tokenDecoded.duration);

    await extendTagAfterSmartContractPay({ domainConfig, domain, tokenDecoded, amountToPay, tagObject, txHash: normalizedHash });

    const result = {
        tagObject,
        confirmed: true,
        amountReceived: String(amountReceivedHuman),
        paymentConfirmation,
        licenseExtension,
    };

    writeScPayCache(cacheKey, sc, tokenDecoded.tagName, result);

    return result;
}

async function verifyPolygonSmartContractPayment(tagName, domain, token, txHash) {
    const { tokenDecoded, domainConfig } = decodeTagPayToken(tagName, domain, token);

    const sc = tokenDecoded.smartContractPOLYGON;

    const { hasNativeWei, hasUsdcPayload, hasUsdtPayload } = assertSmartContractPolygonPresent(sc);

    const { expectedContract, normalizedHash } = resolvePolygonContractAndTxHash(sc, txHash);
    const cacheKey = scPayCacheKey(normalizedHash);

    const cachedBody = readScPayCache(cacheKey, sc, tokenDecoded.tagName);
    if (cachedBody) return cachedBody;

    const tagData = await searchTag({ tagName, domain }, {});
    if (tagData.available) throwPaymentConfirmationTagNotFound(tagName, domain);

    const tagObject = tagData.tagObject;
    const { renewedAtCondition, registeredAtCondition } = renewalShortCircuitFlags(tagObject, tokenDecoded);

    const onChain = await verifyPolygonChainOrFail({
        normalizedHash,
        expectedContract,
        sc,
        hasNativeWei,
        hasUsdcPayload,
        hasUsdtPayload,
        tokenDecoded,
    });

    if (!onChain.ok) return onChain.body;

    const { payMode, eventAmount, amountReceivedHuman, amountToPay } = onChain;
    const paymentConfirmation = buildSmartContractPaymentConfirmation({
        payMode,
        eventAmount,
        amountReceivedHuman,
        normalizedHash,
    });

    if (renewedAtCondition || registeredAtCondition) {
        const result = {
            cache: true,
            confirmed: true,
            amountReceived: String(amountReceivedHuman),
            paymentConfirmation,
            publicData: tagObject.publicData,
            reward: "pending_to_code",
            licenseExtension: null,
        };
        writeScPayCache(cacheKey, sc, tokenDecoded.tagName, result);
        return result;
    }

    const licenseExtension = computeScLicenseExtension(tagObject.publicData.expiresAt, tokenDecoded.duration);

    await extendTagAfterSmartContractPay({ domainConfig, domain, tokenDecoded, amountToPay, tagObject, txHash: normalizedHash });

    const result = {
        tagObject,
        confirmed: true,
        amountReceived: String(amountReceivedHuman),
        paymentConfirmation,
        licenseExtension,
    };

    writeScPayCache(cacheKey, sc, tokenDecoded.tagName, result);

    return result;
}

async function verifyBaseSmartContractPayment(tagName, domain, token, txHash) {
    const { tokenDecoded, domainConfig } = decodeTagPayToken(tagName, domain, token);

    const sc = tokenDecoded.smartContractBASE;

    const { hasNativeWei, hasUsdcPayload, hasUsdtPayload } = assertSmartContractBasePresent(sc);

    const { expectedContract, normalizedHash } = resolveBaseContractAndTxHash(sc, txHash);
    const cacheKey = scPayCacheKey(normalizedHash);

    const cachedBody = readScPayCache(cacheKey, sc, tokenDecoded.tagName);
    if (cachedBody) return cachedBody;

    const tagData = await searchTag({ tagName, domain }, {});
    if (tagData.available) throwPaymentConfirmationTagNotFound(tagName, domain);

    const tagObject = tagData.tagObject;
    const { renewedAtCondition, registeredAtCondition } = renewalShortCircuitFlags(tagObject, tokenDecoded);

    const onChain = await verifyBaseChainOrFail({
        normalizedHash,
        expectedContract,
        sc,
        hasNativeWei,
        hasUsdcPayload,
        hasUsdtPayload,
        tokenDecoded,
    });

    if (!onChain.ok) return onChain.body;

    const { payMode, eventAmount, amountReceivedHuman, amountToPay } = onChain;
    const paymentConfirmation = buildSmartContractPaymentConfirmation({
        payMode,
        eventAmount,
        amountReceivedHuman,
        normalizedHash,
    });

    if (renewedAtCondition || registeredAtCondition) {
        const result = {
            cache: true,
            confirmed: true,
            amountReceived: String(amountReceivedHuman),
            paymentConfirmation,
            publicData: tagObject.publicData,
            reward: "pending_to_code",
            licenseExtension: null,
        };
        writeScPayCache(cacheKey, sc, tokenDecoded.tagName, result);
        return result;
    }

    const licenseExtension = computeScLicenseExtension(tagObject.publicData.expiresAt, tokenDecoded.duration);

    await extendTagAfterSmartContractPay({ domainConfig, domain, tokenDecoded, amountToPay, tagObject, txHash: normalizedHash });

    const result = {
        tagObject,
        confirmed: true,
        amountReceived: String(amountReceivedHuman),
        paymentConfirmation,
        licenseExtension,
    };

    writeScPayCache(cacheKey, sc, tokenDecoded.tagName, result);

    return result;
}

async function verifyBlockdagSmartContractPayment(tagName, domain, token, txHash) {
    const { tokenDecoded, domainConfig } = decodeTagPayToken(tagName, domain, token);

    const sc = tokenDecoded.smartContractBDAG;

    const { hasNativeWei } = assertSmartContractBdagPresent(sc);

    const { expectedContract, normalizedHash } = resolveBlockdagContractAndTxHash(sc, txHash);
    const cacheKey = scPayCacheKey(normalizedHash);

    const cachedBody = readScPayCache(cacheKey, sc, tokenDecoded.tagName);
    if (cachedBody) return cachedBody;

    const tagData = await searchTag({ tagName, domain }, {});
    if (tagData.available) throwPaymentConfirmationTagNotFound(tagName, domain);

    const tagObject = tagData.tagObject;
    const { renewedAtCondition, registeredAtCondition } = renewalShortCircuitFlags(tagObject, tokenDecoded);

    const onChain = await verifyBlockdagChainOrFail({
        normalizedHash,
        expectedContract,
        sc,
        hasNativeWei,
        tokenDecoded,
    });

    if (!onChain.ok) return onChain.body;

    const { payMode, eventAmount, amountReceivedHuman, amountToPay } = onChain;
    const paymentConfirmation = buildSmartContractPaymentConfirmation({
        payMode,
        eventAmount,
        amountReceivedHuman,
        normalizedHash,
    });

    if (renewedAtCondition || registeredAtCondition) {
        const result = {
            cache: true,
            confirmed: true,
            amountReceived: String(amountReceivedHuman),
            paymentConfirmation,
            publicData: tagObject.publicData,
            reward: "pending_to_code",
            licenseExtension: null,
        };
        writeScPayCache(cacheKey, sc, tokenDecoded.tagName, result);
        return result;
    }

    const licenseExtension = computeScLicenseExtension(tagObject.publicData.expiresAt, tokenDecoded.duration);

    await extendTagAfterSmartContractPay({ domainConfig, domain, tokenDecoded, amountToPay, tagObject, txHash: normalizedHash });

    const result = {
        tagObject,
        confirmed: true,
        amountReceived: String(amountReceivedHuman),
        paymentConfirmation,
        licenseExtension,
    };

    writeScPayCache(cacheKey, sc, tokenDecoded.tagName, result);

    return result;
}

/**
 * @param {string} [network] - `AVAX_SC` | `BSC_SC` | `ETH_SC` | `POLYGON_SC` | `BASE_SC` | `BLOCKDAG_SC`
 */
const verifySmartContractPayment = async (tagName, domain, token, txHash, network = "AVAX_SC") => {
    if (network === "BLOCKDAG_SC") {
        return verifyBlockdagSmartContractPayment(tagName, domain, token, txHash);
    }
    if (network === "BSC_SC") {
        return verifyBscSmartContractPayment(tagName, domain, token, txHash);
    }
    if (network === "ETH_SC") {
        return verifyEthSmartContractPayment(tagName, domain, token, txHash);
    }
    if (network === "POLYGON_SC") {
        return verifyPolygonSmartContractPayment(tagName, domain, token, txHash);
    }
    if (network === "BASE_SC") {
        return verifyBaseSmartContractPayment(tagName, domain, token, txHash);
    }
    return verifyAvalancheSmartContractPayment(tagName, domain, token, txHash);
};

module.exports = {
    verifySmartContractPayment,
    throwPaymentConfirmationTagNotFound,
};
