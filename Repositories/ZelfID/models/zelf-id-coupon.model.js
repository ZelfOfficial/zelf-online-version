const mongoose = require("mongoose");

const { addBasicPlugins } = require("../../../Core/mongoose-utils");

const redemptionSchema = new mongoose.Schema(
    {
        zelfId: { type: String, required: true },
        plan: { type: String, required: true },
        duration: { type: String, required: true },
        redeemedAt: { type: Date, required: true },
        // Internal id so a failed grant can pull this redemption back. Not part of the public coupon.
        key: { type: String, required: true },
    },
    { _id: false }
);

/**
 * Percent-off coupon for Zelf ID Premium and Unlimited.
 * `code` is stored uppercase; lookups normalize case before querying.
 */
const zelfIdCouponSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    percentOff: { type: Number, required: true, min: 1, max: 100 },
    plans: {
        type: [{ type: String, enum: ["premium", "unlimited"] }],
        required: true,
    },
    durations: {
        type: [{ type: String, enum: ["1y", "2y", "3y", "lifetime"] }],
        default: [],
    },
    maxRedemptions: { type: Number, required: true, min: 1 },
    perZelfIdLimit: { type: Number, default: 1, min: 1 },
    expiresAt: { type: Date, default: null },
    active: { type: Boolean, default: true },
    createdBy: { type: String, required: true },
    redemptions: { type: [redemptionSchema], default: [] },
});

addBasicPlugins(zelfIdCouponSchema);

module.exports = mongoose.models.ZelfIdCoupon || mongoose.model("ZelfIdCoupon", zelfIdCouponSchema);
