/**
 * Zelf ID v4 payment confirmation. Parallel to my-tags; does not patch it.
 */
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
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
const { expandStoredExtraParams } = require("../../Tags/modules/tags-addresses.module");

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
    listPrice,
}) => {
    if (tokenDecoded?.coupon?.valid !== true || !tokenDecoded.coupon.code) {
        return { blocked: false, claimed: null };
    }
    const Coupons = require("./zelf-ids-coupons.module");
    const bare = `${tagName}`.split(".")[0];
    ZelfIdsPaymentModule.buildMetadata(
        {
            tagName: bare,
            price: price ?? billableUsdPrice,
            domain,
            duration: tokenDecoded.duration || 1,
            plan: tokenDecoded.plan,
            domainConfig,
            paymentMethod: source === "stripe" ? "stripe" : "crypto",
            basePublicData: tagObject.publicData,
        },
        tagObject,
        domainConfig
    );
    try {
        const claimed = await Coupons.claimForGrant({
            code: tokenDecoded.coupon.code,
            zelfId: `${bare}.${domain}`.toLowerCase(),
            plan: tokenDecoded.plan,
            duration: tokenDecoded.duration,
            domainConfig,
            tagName: bare,
            signedAmount: tokenDecoded.amountDue ?? tokenDecoded.billableUsdPrice ?? billableUsdPrice,
            listPrice,
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
const confirmCouponFreeCheckout = async (tagName, domain, tokenDecoded, domainConfig, tagObject, basePublicData, upgradeCreditUsd = 0) => {
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
        // Refuse before a redemption when the pin would drop the lease.
        ZelfIdsPaymentModule.buildMetadata(
            {
                tagName: bare,
                price: 0,
                domain,
                duration: tokenDecoded.duration || 1,
                plan: tokenDecoded.plan,
                domainConfig,
                paymentMethod: "coupon",
                basePublicData: basePublicData || tagObject.publicData,
            },
            tagObject,
            domainConfig
        );
        const { priceAfterUpgradeCredit } = require("./zelf-id-upgrade-credit.module");
        const licenseList = Coupons.licenseListPrice({
            tagName: bare,
            duration: tokenDecoded.duration,
            domainConfig,
            plan: tokenDecoded.plan,
        });
        claimed = await Coupons.claimForGrant({
            code: tokenDecoded.coupon.code,
            zelfId: `${bare}.${domain}`.toLowerCase(),
            plan: tokenDecoded.plan,
            duration: tokenDecoded.duration,
            domainConfig,
            tagName: bare,
            signedAmount: tokenDecoded.amountDue ?? 0,
            requireZero: true,
            listPrice: priceAfterUpgradeCredit(licenseList, upgradeCreditUsd),
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
                basePublicData: basePublicData || tagObject.publicData,
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

const verifyPaymentConfirmation = async (tagName, domain, network, token, identity = {}) => {
    const tokenDecoded = jwt.verify(token, config.JWT_SECRET);
    const domainConfig = getDomainConfig(domain);

    if (!tokenDecoded || !tokenDecoded.tagName || !tokenDecoded.tagPayName) throw new Error("401:tag_not_authenticated");

    if (tokenDecoded.tagName !== `${tagName}.${domain}`) throw new Error("403:tag_not_owned");

    if (network === "FREE") return confirmFreeCheckout(tagName, domain, tokenDecoded, domainConfig, identity, token);

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

    const { claimQuoteGrant, completeQuoteGrant, releaseQuoteGrant } = require("./zelf-id-quote-grant.module");
    const quote = { zelfName: `${tagName}.${domain}`, token };
    const claim = await claimQuoteGrant({ ...quote, source: network });
    if (claim.state === "done") {
        return {
            cache: true,
            confirmed: true,
            amountReceived: paymentConfirmation.amountReceived ?? 0,
            paymentConfirmation,
            publicData: tagObject.publicData,
            expiresAt: tagObject.publicData?.expiresAt || null,
            tagObject,
            paymentMethod: claim.grant?.paymentMethod || "crypto",
        };
    }

    const { assertSignedUpgradeCredit, priceAfterUpgradeCredit } = require("./zelf-id-upgrade-credit.module");
    let freshCredit;
    try {
        freshCredit = await assertSignedUpgradeCredit({
            tokenDecoded,
            publicData: tagObject.publicData,
            tagName,
            domain,
            domainConfig,
            targetPlan: tokenDecoded.plan,
        });
    } catch (error) {
        await releaseQuoteGrant(quote);
        throw error;
    }
    let listPrice;
    if (tokenDecoded?.coupon?.valid === true && tokenDecoded.coupon.code) {
        const CouponsForCredit = require("./zelf-ids-coupons.module");
        const licenseList = CouponsForCredit.licenseListPrice({
            tagName,
            duration: tokenDecoded.duration,
            domainConfig,
            plan: tokenDecoded.plan,
        });
        listPrice = priceAfterUpgradeCredit(licenseList, freshCredit.upgradeCreditUsd);
    }

    let couponGrant = { blocked: false, claimed: null };
    let extension;
    try {
        couponGrant = await claimCouponAfterPayment({
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
            listPrice,
        });
        if (couponGrant.blocked) {
            await releaseQuoteGrant(quote);
            return couponGrant.body;
        }

        extension = await addDurationToTag(
            {
                tagName: tagObject.publicData[domainConfig.getTagKey()].split(".")[0],
                price: tokenDecoded.prices?.[network]?.price ?? amountToPay,
                billableUsdPrice: tokenDecoded.amountDue ?? tokenDecoded.billableUsdPrice ?? tokenDecoded.prices?.[network]?.price,
                cryptoSymbol: network,
                cryptoAmount: amountToPay,
                domain,
                duration: tokenDecoded.duration || 1,
                plan: tokenDecoded.plan,
                domainConfig,
                paymentMethod: "crypto",
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
        await releaseQuoteGrant(quote);
        throw error;
    }

    if (extension.manualReview && couponGrant.claimed) {
        await releaseCouponClaim(couponGrant.claimed);
    }

    if (extension.manualReview) {
        await releaseQuoteGrant(quote);
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

    await completeQuoteGrant({
        ...quote,
        source: network,
        paymentMethod: "crypto",
        couponId: couponGrant.claimed?.couponId,
        plan: tokenDecoded.plan,
        duration: tokenDecoded.duration,
        amountPaidUsd: tokenDecoded.amountDue ?? tokenDecoded.billableUsdPrice ?? tokenDecoded.prices?.[network]?.price,
    });

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
const confirmFreeCheckout = async (tagName, domain, tokenDecoded, domainConfig, identity = {}, quoteToken) => {
    const { getZelfIdCheckoutPrice, normalizePaymentDuration } = require("./zelf-id-plan.module");
    const tagData = await ZelfIdModule.searchTag({ tagName, domain, domainConfig, environment: "all" }, {});

    if (tagData.available) throwPaymentConfirmationTagNotFound(tagName, domain);

    const tagObject = tagData.tagObject;
    // Identity decrypt can repin the same record. Price the grant from the pre-check lease
    // so a free name is not extended as if it were already a paid year.
    const basePublicData = { ...(tagObject.publicData || {}) };

    // Prove control of this name before a replay response, a coupon redemption, or a whitelist grant.
    const { assertFreeCheckoutIdentity } = require("./zelf-id-checkout-identity.module");
    await assertFreeCheckoutIdentity({
        tagName,
        domain,
        tagObject,
        authUser: identity.authUser,
        faceBase64: identity.faceBase64,
        masterPassword: identity.masterPassword,
        password: identity.password,
    });

    const { claimQuoteGrant, completeQuoteGrant, releaseQuoteGrant } = require("./zelf-id-quote-grant.module");
    const quoteKey = { zelfName: `${tagName}.${domain}`, token: quoteToken };
    const claim = await claimQuoteGrant({
        ...quoteKey,
        source: tokenDecoded.coupon?.code ? "coupon" : "whitelist",
    });
    if (claim.state === "done") {
        return {
            cache: true,
            confirmed: true,
            amountReceived: 0,
            tagObject,
            expiresAt: tagObject.publicData?.expiresAt || null,
            paymentMethod: claim.grant?.paymentMethod || (tokenDecoded.coupon?.code ? "coupon" : "whitelist"),
            couponId: claim.grant?.couponId || null,
        };
    }

    const { assertSignedUpgradeCredit } = require("./zelf-id-upgrade-credit.module");
    let freshCredit;
    try {
        freshCredit = await assertSignedUpgradeCredit({
            tokenDecoded,
            publicData: basePublicData,
            tagName,
            domain,
            domainConfig,
            targetPlan: tokenDecoded.plan,
        });
    } catch (error) {
        await releaseQuoteGrant(quoteKey);
        throw error;
    }

    if (tokenDecoded.coupon?.valid === true && tokenDecoded.coupon?.code) {
        let granted;
        try {
            granted = await confirmCouponFreeCheckout(
                tagName,
                domain,
                tokenDecoded,
                domainConfig,
                tagObject,
                basePublicData,
                freshCredit.upgradeCreditUsd
            );
        } catch (error) {
            await releaseQuoteGrant(quoteKey);
            throw error;
        }
        if (!granted.confirmed) {
            await releaseQuoteGrant(quoteKey);
            return granted;
        }
        await completeQuoteGrant({
            ...quoteKey,
            source: "coupon",
            paymentMethod: "coupon",
            couponId: granted.couponId,
            plan: tokenDecoded.plan,
            duration: tokenDecoded.duration,
            amountPaidUsd: 0,
        });
        return granted;
    }

    const { assertPurchaseKeepsPaidValue } = require("./zelf-id-plan.module");
    try {
        assertPurchaseKeepsPaidValue({
            publicData: tagObject.publicData,
            requestedPlan: tokenDecoded.plan,
            tagName,
            domainConfig,
        });
    } catch (error) {
        await releaseQuoteGrant(quoteKey);
        throw error;
    }

    const referralTagName = tagObject.publicData.referralTagName || tokenDecoded.referralTagName || "";
    const duration = normalizePaymentDuration(tokenDecoded.duration || "1");
    const priceQuote = getZelfIdCheckoutPrice({
        tagName: tokenDecoded.tagName,
        duration,
        referralTagName,
        domainConfig,
        requestedPlan: tokenDecoded.plan,
    });
    const { priceAfterUpgradeCredit } = require("./zelf-id-upgrade-credit.module");
    const afterCredit = priceAfterUpgradeCredit(priceQuote.priceWithoutDiscount ?? priceQuote.price, freshCredit.upgradeCreditUsd);
    const coveredByCredit = Number(priceQuote.price) !== 0 && afterCredit === 0;

    if (Number(priceQuote.price) !== 0 && !coveredByCredit) {
        await releaseQuoteGrant(quoteKey);
        throw new Error("409:checkout_total_not_zero");
    }

    if (referralTagName && !tagObject.publicData.referralTagName) {
        tagObject.publicData.referralTagName = referralTagName;
        tagObject.publicData.referralSolanaAddress = tokenDecoded.payment?.referralSolanaAddress || "";
    }

    let extension;
    try {
        extension = await addDurationToTag(
            {
                tagName: tagObject.publicData[domainConfig.getTagKey()].split(".")[0],
                price: 0,
                domain,
                duration: tokenDecoded.duration || 1,
                plan: tokenDecoded.plan,
                domainConfig,
                paymentMethod: coveredByCredit ? "free" : "whitelist",
                billableUsdPrice: 0,
                basePublicData,
            },
            tagObject
        );
    } catch (error) {
        await releaseQuoteGrant(quoteKey);
        throw error;
    }

    await completeQuoteGrant({
        ...quoteKey,
        source: coveredByCredit ? "upgrade_credit" : "whitelist",
        paymentMethod: coveredByCredit ? "free" : "whitelist",
        plan: tokenDecoded.plan,
        duration: tokenDecoded.duration,
        amountPaidUsd: 0,
    });

    return {
        tagObject: extension.tagObject || tagObject,
        expiresAt: extension.expiresAt || tagObject.publicData?.expiresAt || null,
        confirmed: true,
        amountReceived: 0,
        paymentMethod: coveredByCredit ? "free" : "whitelist",
        referralTagName: referralTagName || null,
        ipfsId: extension.ipfsId,
        arweaveId: extension.arweaveId,
    };
};

const persistZelfIdMetadata = async (params, tagObject, domainConfig, metadata, planTerm, options = {}) => {
    await ZelfIdsPaymentModule.ensureZelfProofQRCode(tagObject);

    if (domainConfig.isIPFSEnabled()) {
        await ZelfIdsPaymentModule.storeInIPFS(tagObject, domainConfig, metadata);
    }

    if (domainConfig.isArweaveEnabled()) {
        await ZelfIdsPaymentModule.storeInArweave(tagObject, domainConfig, metadata);
    }

    let expiresAt = null;
    try {
        if (metadata?.extraParams) {
            const parsed = expandStoredExtraParams(metadata.extraParams);
            expiresAt = parsed.expiresAt || null;
            if (parsed.plan) {
                tagObject.publicData = { ...tagObject.publicData, plan: parsed.plan, expiresAt, eventID: parsed.eventID };
            }
            if (parsed.duration != null && parsed.duration !== "") tagObject.publicData.duration = parsed.duration;
            if (parsed.planExpiresAt) tagObject.publicData.planExpiresAt = parsed.planExpiresAt;
            else if (parsed.duration === "lifetime" || (planTerm && !planTerm.planExpiresAt)) delete tagObject.publicData.planExpiresAt;
            if (parsed.renewedAt) tagObject.publicData.renewedAt = parsed.renewedAt;
            if (parsed.registeredAt) tagObject.publicData.registeredAt = parsed.registeredAt;
            if (parsed.paymentMethod) tagObject.publicData.paymentMethod = parsed.paymentMethod;
            if (parsed.price === 0 || parsed.price) tagObject.publicData.price = parsed.price;
            if (parsed.revenueCatOriginalTransactionId) {
                tagObject.publicData.revenueCatOriginalTransactionId = parsed.revenueCatOriginalTransactionId;
            }
        }
    } catch (_error) {
        /* optional */
    }

    if (params.couponId) {
        tagObject.publicData.couponId = params.couponId;
        tagObject.publicData.payment = { method: "coupon", couponId: params.couponId };
    }

    const { savePlanTerm } = require("./zelf-id-plan-term.module");
    const { combineAmountPaid } = require("./zelf-id-upgrade-credit.module");
    const PlanTerm = require("../models/zelf-id-plan-term.model");
    const storedName = tagObject.publicData?.tagName || tagObject.publicData?.zelfName || params.tagName;
    const explicitCharge = params.billableUsdPrice != null ? Number(params.billableUsdPrice) : params.amountPaidUsd != null ? Number(params.amountPaidUsd) : null;
    const zeroMethods = new Set(["coupon", "whitelist", "free", "gift"]);
    const charged = Number.isFinite(explicitCharge) ? explicitCharge : zeroMethods.has(params.paymentMethod) ? 0 : null;
    let amountPaidUsd;
    if (charged != null && mongoose.connection.readyState === 1) {
        const { normalizeZelfName } = require("../../Tags/modules/zelf-name.util");
        const normalized = normalizeZelfName(storedName, params.domain || domainConfig?.name || "zelf");
        const existing = normalized.zelfName ? await PlanTerm.findOne({ zelfName: normalized.zelfName }).lean() : null;
        amountPaidUsd = combineAmountPaid({
            previousPlan: existing?.plan,
            previousAmount: existing?.amountPaidUsd,
            nextPlan: planTerm?.plan || params.plan,
            charged,
        });
    }
    if (planTerm) {
        if (planTerm.planExpiresAt) tagObject.publicData.planExpiresAt = planTerm.planExpiresAt;
        if (planTerm.paymentMethod) tagObject.publicData.paymentMethod = planTerm.paymentMethod;
        if (planTerm.duration) tagObject.publicData.planDuration = planTerm.duration;
        await savePlanTerm({
            zelfName: storedName,
            domain: params.domain || domainConfig?.name,
            plan: planTerm.plan,
            planExpiresAt: planTerm.planExpiresAt,
            paymentMethod: planTerm.paymentMethod,
            duration: planTerm.duration,
            ...(amountPaidUsd !== undefined ? { amountPaidUsd } : {}),
        });
    } else if (amountPaidUsd !== undefined) {
        await savePlanTerm({
            zelfName: storedName,
            domain: params.domain || domainConfig?.name,
            plan: params.plan,
            paymentMethod: params.paymentMethod,
            amountPaidUsd,
        });
    }
    if (!planTerm && options.clearPlanTerm) {
        const { deletePlanTerm } = require("./zelf-id-plan-term.module");
        const storedName = tagObject.publicData?.tagName || tagObject.publicData?.zelfName || params.tagName;
        await deletePlanTerm(storedName, params.domain || domainConfig?.name);
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

    const built = ZelfIdsPaymentModule.buildMetadata(params, tagObject, domainConfig);

    return persistZelfIdMetadata(params, tagObject, domainConfig, built.metadata, built.planTerm);
};

const revertZelfIdToFreePlan = async (params, tagObject) => {
    const { domain } = params;
    const domainConfig = params.domainConfig || getDomainConfig(domain || "zelf");
    const built = ZelfIdsPaymentModule.buildFreePlanRevertMetadata(params, tagObject, domainConfig);

    return persistZelfIdMetadata(params, tagObject, domainConfig, built.metadata, built.planTerm, { clearPlanTerm: built.clearPlanTerm });
};

const changeZelfIdPlan = async (params, tagObject) => {
    const { domain } = params;
    const domainConfig = params.domainConfig || getDomainConfig(domain || "zelf");
    const built = ZelfIdsPaymentModule.buildPlanChangeMetadata(params, tagObject, domainConfig);

    return persistZelfIdMetadata(params, tagObject, domainConfig, built.metadata, built.planTerm);
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
