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

const releaseCouponClaim = async (claimed) => {
    if (!claimed?.couponId || !claimed?.redemptionKey) return;
    const Coupons = require("./zelf-ids-coupons.module");
    await Coupons.releaseRedemption(claimed);
};

/**
 * After a captured Stripe or crypto payment, record the coupon redemption.
 * A failed recheck does not grant the plan; the captured payment is kept for manual review.
 * @returns {Promise<{ blocked: boolean, claimed: object|null, body?: object }>}
 */
const claimCouponAfterPayment = async ({
    tokenDecoded,
    tagName,
    domain,
    domainConfig,
    tagObject,
    source,
    price,
    billableUsdPrice,
    cryptoSymbol,
    cryptoAmount,
    paymentNetwork,
    sessionId,
    txHash,
    paymentInitiatedAt,
    amountReceived,
}) => {
    if (tokenDecoded?.coupon?.valid !== true || !tokenDecoded.coupon.code) {
        return { blocked: false, claimed: null };
    }
    const Coupons = require("./zelf-ids-coupons.module");
    const bare = `${tagName}`.split(".")[0];
    try {
        const claimed = await Coupons.claimForGrant({
            code: tokenDecoded.coupon.code,
            zelfId: `${bare}.${domain}`.toLowerCase(),
            plan: tokenDecoded.plan,
            duration: tokenDecoded.duration,
            domainConfig,
            tagName: bare,
            signedAmount: tokenDecoded.amountDue ?? tokenDecoded.billableUsdPrice ?? billableUsdPrice,
        });
        return { blocked: false, claimed };
    } catch (error) {
        const { recordPurchaseManualReview } = require("./zelf-id-purchase-manual-review.module");
        await recordPurchaseManualReview({
            tagName: bare,
            domain,
            plan: tokenDecoded.plan,
            duration: tokenDecoded.duration,
            price,
            billableUsdPrice,
            cryptoSymbol,
            cryptoAmount,
            source: source || "coupon",
            violationCode: error.clientCode || "coupon_invalid",
            sessionId,
            txHash,
            paymentNetwork,
            paymentInitiatedAt,
            tagObject,
            domainConfig,
        });
        return {
            blocked: true,
            claimed: null,
            body: {
                tagObject,
                confirmed: false,
                manualReview: true,
                reason: error.clientCode || "coupon_invalid",
                amountReceived: amountReceived ?? 0,
            },
        };
    }
};

/**
 * 100% coupon: same purchase rules as a paid checkout, then the free-checkout grant.
 * The redemption is conditional and is rolled back if the grant does not stick.
 */
const confirmCouponFreeCheckout = async (tagName, domain, tokenDecoded, domainConfig, tagObject) => {
    const Coupons = require("./zelf-ids-coupons.module");
    const bare = tagObject.publicData[domainConfig.getTagKey()].split(".")[0];
    Coupons.assertCouponPlanRules({
        publicData: tagObject.publicData,
        requestedPlan: tokenDecoded.plan,
        tagName: bare,
        domainConfig,
        duration: tokenDecoded.duration || "1",
    });

    let claimed = null;
    try {
        claimed = await Coupons.claimForGrant({
            code: tokenDecoded.coupon.code,
            zelfId: `${bare}.${domain}`.toLowerCase(),
            plan: tokenDecoded.plan,
            duration: tokenDecoded.duration,
            domainConfig,
            tagName: bare,
            signedAmount: tokenDecoded.amountDue ?? 0,
            requireZero: true,
        });
        const extension = await addDurationToTag(
            {
                tagName: bare,
                price: 0,
                domain,
                duration: tokenDecoded.duration || 1,
                plan: tokenDecoded.plan,
                domainConfig,
                paymentMethod: "coupon",
                couponId: claimed.couponId,
            },
            tagObject
        );
        if (extension.manualReview) {
            await releaseCouponClaim(claimed);
            return {
                tagObject: extension.tagObject || tagObject,
                confirmed: false,
                manualReview: true,
                reason: extension.reason,
                amountReceived: 0,
            };
        }
        return {
            tagObject: extension.tagObject || tagObject,
            expiresAt: extension.expiresAt || tagObject.publicData?.expiresAt || null,
            confirmed: true,
            paymentMethod: "coupon",
            couponId: claimed.couponId,
            amountReceived: 0,
            ipfsId: extension.ipfsId,
            arweaveId: extension.arweaveId,
        };
    } catch (error) {
        await releaseCouponClaim(claimed);
        throw error;
    }
};

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

    const couponGrant = await claimCouponAfterPayment({
        tokenDecoded,
        tagName,
        domain,
        domainConfig,
        tagObject,
        source: network,
        price: tokenDecoded.prices?.[network]?.price ?? amountToPay,
        billableUsdPrice: tokenDecoded.amountDue ?? tokenDecoded.billableUsdPrice ?? tokenDecoded.prices?.[network]?.price,
        cryptoSymbol: network,
        cryptoAmount: amountToPay,
        paymentNetwork: network,
        paymentInitiatedAt: tokenDecoded.initiatedAt,
        amountReceived: paymentConfirmation.amountReceived,
    });
    if (couponGrant.blocked) return couponGrant.body;

    let extension;
    try {
        extension = await addDurationToTag(
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
                couponId: couponGrant.claimed?.couponId,
            },
            tagObject
        );
    } catch (error) {
        await releaseCouponClaim(couponGrant.claimed);
        throw error;
    }

    if (extension.manualReview && couponGrant.claimed) {
        await releaseCouponClaim(couponGrant.claimed);
    }

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
        const cached = {
            cache: true,
            confirmed: true,
            amountReceived: 0,
            tagObject,
            expiresAt: tagObject.publicData?.expiresAt || null,
        };
        if (tagObject.publicData.paymentMethod === "coupon") {
            cached.paymentMethod = "coupon";
            cached.couponId = tagObject.publicData.couponId || null;
        }
        return cached;
    }

    if (tokenDecoded.coupon?.valid === true && tokenDecoded.coupon?.code) {
        return confirmCouponFreeCheckout(tagName, domain, tokenDecoded, domainConfig, tagObject);
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
            if (parsed.renewedAt) tagObject.publicData.renewedAt = parsed.renewedAt;
            if (parsed.registeredAt) tagObject.publicData.registeredAt = parsed.registeredAt;
            if (parsed.paymentMethod) tagObject.publicData.paymentMethod = parsed.paymentMethod;
            if (parsed.couponId) tagObject.publicData.couponId = parsed.couponId;
            if (parsed.paymentMethod === "coupon" && parsed.couponId) {
                tagObject.publicData.payment = { method: "coupon", couponId: parsed.couponId };
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
