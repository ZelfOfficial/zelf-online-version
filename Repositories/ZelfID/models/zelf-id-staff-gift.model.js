const mongoose = require("mongoose");

const { addBasicPlugins } = require("../../../Core/mongoose-utils");

/** Audit trail for staff-granted (price 0, paymentMethod "gift") Zelf ID plans. */
const zelfIdStaffGiftSchema = new mongoose.Schema({
    tagName: { type: String, required: true },
    domain: { type: String, required: true },
    plan: { type: String, required: true },
    duration: { type: String, required: true },
    reason: { type: String, required: true },
    staffId: { type: String, default: "" },
    staffEmail: { type: String, default: "" },
    ownerEmail: { type: String, default: "" },
    action: { type: String, enum: ["rebuilt_and_gifted", "gifted"], required: true },
    proofVersion: { type: String, default: "" },
    proofType: { type: String, default: "" },
    expiresAt: { type: String, default: "" },
    ipfsCid: { type: String, default: "" },
});

zelfIdStaffGiftSchema.index({ tagName: 1, domain: 1 });

addBasicPlugins(zelfIdStaffGiftSchema);

module.exports = mongoose.model("ZelfIdStaffGift", zelfIdStaffGiftSchema);
