const mongoose = require("mongoose");

const { addBasicPlugins } = require("../../../Core/mongoose-utils");

/**
 * Plan term that does not fit in the Pinata `extraParams` value.
 * Keyed by the normalized `name.domain`. The pin still holds `plan`, `expiresAt`, and `duration`.
 */
const zelfIdPlanTermSchema = new mongoose.Schema({
    zelfName: { type: String, required: true, unique: true, lowercase: true, trim: true },
    plan: { type: String, default: null },
    planExpiresAt: { type: String, default: null },
    paymentMethod: { type: String, default: null },
    duration: { type: String, default: null },
    amountPaidUsd: { type: Number, default: null },
    quoteHash: { type: String, default: null },
    termStartedAt: { type: Date, default: null },
});

addBasicPlugins(zelfIdPlanTermSchema);

module.exports = mongoose.models.ZelfIdPlanTerm || mongoose.model("ZelfIdPlanTerm", zelfIdPlanTermSchema);
