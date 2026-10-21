/**
 * Record a captured payment that must not be stamped (tier/lifetime guard).
 * One row per payment id (Stripe session, on-chain tx, RevenueCat event, or signed checkout).
 */
const resolvePaymentKey = ({
    sessionId,
    txHash,
    paymentNetwork,
    eventID,
    paymentInitiatedAt,
    tagName,
    domain,
} = {}) => {
    if (sessionId) return `stripe:session:${String(sessionId).trim()}`;
    const hash = txHash ? String(txHash).trim() : "";
    const network = paymentNetwork ? String(paymentNetwork).trim().toUpperCase() : "";
    if (hash && network) return `crypto:${network}:${hash}`;
    if (eventID) return `revenuecat:event:${String(eventID).trim()}`;
    const bare = tagName ? String(tagName).trim().toLowerCase().split(".")[0] : "";
    const dom = domain ? String(domain).trim().toLowerCase() : "";
    if (bare && dom && paymentInitiatedAt != null) {
        return `checkout:${dom}:${bare}:${paymentInitiatedAt}`;
    }
    return null;
};

const buildManualReviewContext = ({ params, tagObject, domainConfig, violationCode, bareName, domainName }) => {
    const { effectivePlan } = require("./zelf-id-plan.module");
    const usdAmount = Number(params.billableUsdPrice ?? params.price);
    const amounts = {
        usd: {
            currency: "USD",
            amount: Number.isFinite(usdAmount) ? usdAmount : 0,
        },
    };

    if (params.cryptoSymbol != null && params.cryptoAmount != null) {
        amounts.crypto = {
            currency: String(params.cryptoSymbol),
            amount: params.cryptoAmount,
        };
    }

    return {
        tag: `${bareName}.${domainName}`,
        requestedPlan: params.plan || params.requestedPlan || "",
        requestedDuration: `${params.duration ?? ""}`,
        currentPlan: effectivePlan(tagObject.publicData, domainConfig),
        currentDuration: tagObject.publicData?.duration ?? "",
        currentExpiresAt: tagObject.publicData?.expiresAt ?? null,
        sessionId: params.sessionId || undefined,
        txHash: params.txHash || undefined,
        paymentNetwork: params.paymentNetwork || params.paymentSource || undefined,
        eventID: params.eventID || undefined,
        amounts,
        violationCode,
    };
};

const recordPurchaseManualReview = async ({
    tagName,
    domain,
    plan,
    duration,
    price,
    billableUsdPrice,
    cryptoSymbol,
    cryptoAmount,
    source,
    violationCode,
    sessionId,
    txHash,
    paymentNetwork,
    eventID,
    paymentInitiatedAt,
    params = {},
    tagObject,
    domainConfig,
}) => {
    const bareName = String(tagName || "").trim().toLowerCase().split(".")[0];
    const domainName = String(domain || "").trim().toLowerCase();
    const paymentKey = resolvePaymentKey({
        sessionId,
        txHash,
        paymentNetwork,
        eventID,
        paymentInitiatedAt,
        tagName: bareName,
        domain: domainName,
    });

    const context = buildManualReviewContext({
        params: {
            plan,
            duration,
            price,
            billableUsdPrice,
            cryptoSymbol,
            cryptoAmount,
            sessionId,
            txHash,
            paymentNetwork,
            paymentSource: source,
            eventID,
            ...params,
        },
        tagObject,
        domainConfig,
        violationCode,
        bareName,
        domainName,
    });

    const payload = {
        tagName: bareName,
        domain: domainName,
        plan: String(plan || ""),
        duration: `${duration ?? ""}`,
        price: Number(price) || 0,
        source: String(source || "unknown"),
        violationCode: String(violationCode || "409:plan_downgrade_not_allowed"),
        status: "needs_manual_review",
        paymentKey: paymentKey || undefined,
        context,
    };

    console.error("[zelf-id] purchase blocked after payment; needs manual review", {
        paymentKey,
        tagName: payload.tagName,
        domain: payload.domain,
        violationCode: payload.violationCode,
        source: payload.source,
    });

    try {
        const Model = require("../models/zelf-id-purchase-manual-review.model");

        if (paymentKey) {
            const existing = await Model.findOne({ paymentKey });
            if (existing) {
                const record = typeof existing.toObject === "function" ? existing.toObject() : existing;
                return { record, created: false };
            }
            try {
                const record = await Model.create(payload);
                return { record, created: true };
            } catch (error) {
                if (error?.code === 11000) {
                    const dup = await Model.findOne({ paymentKey });
                    const record = dup && typeof dup.toObject === "function" ? dup.toObject() : dup;
                    return { record, created: false };
                }
                throw error;
            }
        }

        const record = await Model.create(payload);
        return { record, created: true };
    } catch (error) {
        console.error("[zelf-id] failed to persist manual review record", error?.message || error);
        return { record: null, created: false };
    }
};

module.exports = {
    resolvePaymentKey,
    recordPurchaseManualReview,
};
