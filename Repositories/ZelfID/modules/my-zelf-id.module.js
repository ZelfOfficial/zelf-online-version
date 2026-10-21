/**
 * Zelf ID v4 payment confirmation. Parallel to my-tags; does not patch it.
 */
const moment = require("moment");
const jwt = require("jsonwebtoken");
const config = require("../../../Core/config");
const { getDomainConfig } = require("../../Tags/config/supported-domains");
const { coerceInitiatedAtUnix } = require("../../Tags/modules/tag-pay-session-tx.util");
const {
    throwPaymentConfirmationTagNotFound,
    verifySmartContractPayment: verifyTagsSmartContractPayment,
} = require("../../Tags/modules/tag-smart-contract-payment.module");
const { confirmPayUniqueAddress } = require("../../Tags/modules/my-tags.module");
const ZelfIdModule = require("./zelf-id.module");
const ZelfIdsPaymentModule = require("./zelf-ids-payment.module");

const verifyPaymentConfirmation = async (tagName, domain, network, token) => {
    const tokenDecoded = jwt.verify(token, config.JWT_SECRET);
    const domainConfig = getDomainConfig(domain);

    if (!tokenDecoded || !tokenDecoded.tagName || !tokenDecoded.tagPayName) throw new Error("401:tag_not_authenticated");

    if (tokenDecoded.tagName !== `${tagName}.${domain}`) throw new Error("403:tag_not_owned");

    if (network === "FREE") return confirmFreeCheckout(tagName, domain, tokenDecoded, domainConfig);

    if (network === "AVAX") {
        throw new Error("409:avax_use_smart_contract_confirmation");
    }

    const tagData = await ZelfIdModule.searchTag({ tagName, domain, domainConfig, environment: "all" }, {});

    if (tagData.available) throwPaymentConfirmationTagNotFound(tagName, domain);

    const tagObject = tagData.tagObject;
    const amountToPay = tokenDecoded.prices[network]?.amountToSend;
    const initiatedAtUnix = coerceInitiatedAtUnix(tokenDecoded.initiatedAt);

    const addressMapping = {
        ETH: tokenDecoded.paymentAddress.ethAddress,
        SOL: tokenDecoded.paymentAddress.solanaAddress,
        BTC: tokenDecoded.paymentAddress.btcAddress,
        AVAX: tokenDecoded.paymentAddress.avalancheAddress || tokenDecoded.paymentAddress.ethAddress,
        BDAG: tokenDecoded.paymentAddress?.blockdagAddress || tokenDecoded.paymentAddress?.ethAddress,
    };

    const paymentConfirmation = await confirmPayUniqueAddress(network, addressMapping[network], amountToPay, { initiatedAtUnix });

    const initiatedAt = tokenDecoded.initiatedAt ? moment.unix(tokenDecoded.initiatedAt) : null;
    const renewedAtCondition = Boolean(tagObject.publicData.renewedAt && initiatedAt && moment(tagObject.publicData.renewedAt).isAfter(initiatedAt));
    const registeredAtCondition = Boolean(tokenDecoded.initiatedAt && moment(tagObject.publicData.registeredAt).isAfter(initiatedAt));

    if (renewedAtCondition || registeredAtCondition) {
        return {
            cache: true,
            confirmed: paymentConfirmation.confirmed,
            amountReceived: paymentConfirmation.amountReceived,
            paymentConfirmation,
            publicData: tagObject.publicData,
            expiresAt: tagObject.publicData?.expiresAt || null,
            tagObject,
        };
    }

    const paymentOk = paymentConfirmation && typeof paymentConfirmation === "object" && paymentConfirmation.confirmed === true;

    if (!paymentOk) {
        const _paymentConfirmation = paymentConfirmation && typeof paymentConfirmation === "object" ? paymentConfirmation : null;

        return {
            tagObject,
            confirmed: false,
            amountReceived: _paymentConfirmation?.amountReceived ?? 0,
            ...(_paymentConfirmation ? { paymentConfirmation: _paymentConfirmation } : {}),
        };
    }

    const extension = await addDurationToTag(
        {
            tagName: tagObject.publicData[domainConfig.getTagKey()].split(".")[0],
            price: tokenDecoded.prices?.[network]?.price ?? amountToPay,
            billableUsdPrice: tokenDecoded.prices?.[network]?.price,
            cryptoSymbol: network,
            cryptoAmount: amountToPay,
            domain,
            duration: tokenDecoded.duration || 1,
            plan: tokenDecoded.plan,
            domainConfig,
            paymentCaptured: true,
            paymentSource: network,
            paymentNetwork: network,
            paymentInitiatedAt: tokenDecoded.initiatedAt,
        },
        tagObject
    );

    if (extension.manualReview) {
        return {
            tagObject: extension.tagObject || tagObject,
            confirmed: false,
            manualReview: true,
            cache: Boolean(extension.manualReviewCache),
            status: extension.status,
            reason: extension.reason,
            expiresAt: extension.expiresAt || tagObject.publicData?.expiresAt || null,
            amountReceived: paymentConfirmation.amountReceived,
        };
    }

    if (extension.expiresAt && tagObject.publicData) {
        tagObject.publicData.expiresAt = extension.expiresAt;
    }

    return {
        tagObject: extension.tagObject || tagObject,
        expiresAt: extension.expiresAt || tagObject.publicData?.expiresAt || null,
        confirmed: true,
        amountReceived: paymentConfirmation.amountReceived,
    };
};

/**
 * Confirm a checkout whose license quote is $0 (100% license coupon / whitelist referral).
 * Re-quotes on the server from the license with the signed plan, duration and referral;
 * refuses unless the total is exactly $0. No Stripe or on-chain payment is involved.
 */
const confirmFreeCheckout = async (tagName, domain, tokenDecoded, domainConfig) => {
    const { getZelfIdCheckoutPrice, normalizePaymentDuration } = require("./zelf-id-plan.module");
    const tagData = await ZelfIdModule.searchTag({ tagName, domain, domainConfig, environment: "all" }, {});

    if (tagData.available) throwPaymentConfirmationTagNotFound(tagName, domain);

    const tagObject = tagData.tagObject;
    const initiatedAt = tokenDecoded.initiatedAt ? moment.unix(tokenDecoded.initiatedAt) : null;
    const renewedAt = tagObject.publicData.renewedAt || tagObject.publicData.registeredAt;

    // Same signed checkout already applied: return the record, never stamp twice.
    if (initiatedAt && renewedAt && moment(renewedAt).isAfter(initiatedAt)) {
        return { cache: true, confirmed: true, amountReceived: 0, tagObject, expiresAt: tagObject.publicData?.expiresAt || null };
    }

    const { assertPurchaseKeepsPaidValue } = require("./zelf-id-plan.module");
    assertPurchaseKeepsPaidValue({
        publicData: tagObject.publicData,
        requestedPlan: tokenDecoded.plan,
        tagName,
        domainConfig,
    });

    const referralTagName = tagObject.publicData.referralTagName || tokenDecoded.referralTagName || "";
    const duration = normalizePaymentDuration(tokenDecoded.duration || "1");
    const quote = getZelfIdCheckoutPrice({
        tagName: tokenDecoded.tagName,
        duration,
        referralTagName,
        domainConfig,
        requestedPlan: tokenDecoded.plan,
    });

    if (Number(quote.price) !== 0) throw new Error("409:checkout_total_not_zero");

    if (referralTagName && !tagObject.publicData.referralTagName) {
        tagObject.publicData.referralTagName = referralTagName;
        tagObject.publicData.referralSolanaAddress = tokenDecoded.payment?.referralSolanaAddress || "";
    }

    const extension = await addDurationToTag(
        {
            tagName: tagObject.publicData[domainConfig.getTagKey()].split(".")[0],
            price: 0,
            domain,
            duration: tokenDecoded.duration || 1,
            plan: tokenDecoded.plan,
            domainConfig,
        },
        tagObject
    );

    return {
        tagObject: extension.tagObject || tagObject,
        expiresAt: extension.expiresAt || tagObject.publicData?.expiresAt || null,
        confirmed: true,
        amountReceived: 0,
        referralTagName: referralTagName || null,
        ipfsId: extension.ipfsId,
        arweaveId: extension.arweaveId,
    };
};

const persistZelfIdMetadata = async (params, tagObject, domainConfig, metadata) => {
    await ZelfIdsPaymentModule.ensureZelfProofQRCode(tagObject);

    if (domainConfig.isIPFSEnabled()) {
        await ZelfIdsPaymentModule.storeInIPFS(tagObject, domainConfig, metadata);
    }

    if (domainConfig.isArweaveEnabled()) {
        await ZelfIdsPaymentModule.storeInArweave(tagObject, domainConfig, metadata);
    }

    let expiresAt = null;
    try {
        if (metadata?.extraParams && typeof metadata.extraParams === "string") {
            const parsed = JSON.parse(metadata.extraParams);
            expiresAt = parsed.expiresAt || null;
            if (parsed.plan) {
                tagObject.publicData = { ...tagObject.publicData, plan: parsed.plan, expiresAt, eventID: parsed.eventID };
            }
            if (parsed.revenueCatOriginalTransactionId) {
                tagObject.publicData.revenueCatOriginalTransactionId = parsed.revenueCatOriginalTransactionId;
            }
        }
    } catch (_error) {
        /* optional */
    }

    const arweaveSkipped = Boolean(tagObject.arweave?.skipped);
    const warnings = [];
    if (arweaveSkipped && domainConfig.isArweaveEnabled()) {
        warnings.push("arweave_upload_skipped_file_too_large");
    }

    const ipfsRec = tagObject.ipfs;
    const arwRec = tagObject.arweave;

    return {
        tagObject,
        expiresAt,
        ipfsId: ipfsRec?.id ?? tagObject.ipfsId ?? null,
        arweaveId: arweaveSkipped ? null : arwRec?.id ?? null,
        masterIPFSRecord: ipfsRec,
        masterArweaveRecord: arweaveSkipped ? null : arwRec,
        arweaveSkipped,
        warnings,
    };
};

const addDurationToTag = async (params, tagObject) => {
    const { domain } = params;
    const domainConfig = params.domainConfig || getDomainConfig(domain || "zelf");
    const tagKey = domainConfig.getTagKey();
    const bareName =
        params.tagName ||
        String(tagObject.publicData?.[tagKey] || tagObject.publicData?.tagName || tagObject.publicData?.zelfName || "")
            .split(".")[0];
    const { getPurchaseKeepsPaidValueViolation } = require("./zelf-id-plan.module");
    const violation = getPurchaseKeepsPaidValueViolation({
        publicData: tagObject.publicData,
        requestedPlan: params.plan || params.requestedPlan,
        tagName: bareName,
        domainConfig,
    });

    if (violation) {
        if (params.paymentCaptured) {
            const { recordPurchaseManualReview } = require("./zelf-id-purchase-manual-review.module");
            const { created } = await recordPurchaseManualReview({
                tagName: bareName,
                domain: domain || domainConfig.name,
                plan: params.plan,
                duration: params.duration,
                price: params.price,
                billableUsdPrice: params.billableUsdPrice,
                cryptoSymbol: params.cryptoSymbol,
                cryptoAmount: params.cryptoAmount,
                source: params.paymentSource || "unknown",
                violationCode: violation,
                sessionId: params.sessionId,
                txHash: params.txHash,
                paymentNetwork: params.paymentNetwork || params.paymentSource,
                eventID: params.eventID,
                paymentInitiatedAt: params.paymentInitiatedAt,
                params,
                tagObject,
                domainConfig,
            });
            return {
                manualReview: true,
                manualReviewCache: !created,
                status: "needs_manual_review",
                reason: violation,
                tagObject,
                expiresAt: tagObject.publicData?.expiresAt || null,
            };
        }
        throw new Error(violation);
    }

    const { metadata } = ZelfIdsPaymentModule.buildMetadata(params, tagObject, domainConfig);

    return persistZelfIdMetadata(params, tagObject, domainConfig, metadata);
};

const revertZelfIdToFreePlan = async (params, tagObject) => {
    const { domain } = params;
    const domainConfig = params.domainConfig || getDomainConfig(domain || "zelf");
    const { metadata } = ZelfIdsPaymentModule.buildFreePlanRevertMetadata(params, tagObject, domainConfig);

    return persistZelfIdMetadata(params, tagObject, domainConfig, metadata);
};

const changeZelfIdPlan = async (params, tagObject) => {
    const { domain } = params;
    const domainConfig = params.domainConfig || getDomainConfig(domain || "zelf");
    const { metadata } = ZelfIdsPaymentModule.buildPlanChangeMetadata(params, tagObject, domainConfig);

    return persistZelfIdMetadata(params, tagObject, domainConfig, metadata);
};

const getPaymentOptions = (tagName, domain, duration, authUser, requestOptions = {}) =>
    ZelfIdsPaymentModule.getPaymentOptions(tagName, domain, duration, authUser, requestOptions);

const verifySmartContractPayment = (tagName, domain, token, txHash, network) =>
    verifyTagsSmartContractPayment(tagName, domain, token, txHash, network);

module.exports = {
    verifyPaymentConfirmation,
    verifySmartContractPayment,
    addDurationToTag,
    revertZelfIdToFreePlan,
    changeZelfIdPlan,
    getPaymentOptions,
};
