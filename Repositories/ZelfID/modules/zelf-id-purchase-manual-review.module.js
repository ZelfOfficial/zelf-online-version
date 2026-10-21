/**
 * Record a captured payment that must not be stamped (tier/lifetime guard).
 */
const recordPurchaseManualReview = async ({
    tagName,
    domain,
    plan,
    duration,
    price,
    source,
    violationCode,
    context = {},
}) => {
    const payload = {
        tagName: String(tagName || "").trim(),
        domain: String(domain || "").trim(),
        plan: String(plan || ""),
        duration: `${duration ?? ""}`,
        price: Number(price) || 0,
        source: String(source || "unknown"),
        violationCode: String(violationCode || "409:plan_downgrade_not_allowed"),
        status: "needs_manual_review",
        context,
    };

    console.error("[zelf-id] purchase blocked after payment; needs manual review", payload);

    try {
        const Model = require("../models/zelf-id-purchase-manual-review.model");
        return await Model.create(payload);
    } catch (error) {
        console.error("[zelf-id] failed to persist manual review record", error?.message || error);
        return null;
    }
};

module.exports = {
    recordPurchaseManualReview,
};
