const mongoose = require("mongoose");

const { addBasicPlugins } = require("../../../Core/mongoose-utils");

/** Paid checkout that could not be stamped (downgrade / lifetime guard) — needs refund or manual review. */
const zelfIdPurchaseManualReviewSchema = new mongoose.Schema({
    tagName: { type: String, required: true },
    domain: { type: String, required: true },
    plan: { type: String, default: "" },
    duration: { type: String, default: "" },
    price: { type: Number, default: 0 },
    source: { type: String, required: true },
    violationCode: { type: String, required: true },
    status: { type: String, enum: ["needs_manual_review"], default: "needs_manual_review" },
    /** Stripe session id, on-chain tx id, or RevenueCat event id — at most one review row per payment. */
    paymentKey: { type: String, sparse: true, unique: true },
    context: { type: mongoose.Schema.Types.Mixed, default: {} },
});

zelfIdPurchaseManualReviewSchema.index({ tagName: 1, domain: 1, createdAt: -1 });

addBasicPlugins(zelfIdPurchaseManualReviewSchema);

module.exports = mongoose.model("ZelfIdPurchaseManualReview", zelfIdPurchaseManualReviewSchema);
