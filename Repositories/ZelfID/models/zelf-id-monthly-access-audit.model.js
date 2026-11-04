const mongoose = require("mongoose");

const Schema = mongoose.Schema;
const { addBasicPlugins } = require("../../../Core/mongoose-utils");

/**
 * Append-only monthly access events for one Zelf ID.
 */
const zelfIdMonthlyAccessAuditSchema = new Schema({
    zelfName: { type: String, required: true },
    periodKey: { type: String, required: true },
    event: {
        type: String,
        enum: ["quoted", "grace_opened", "grace_blocked", "paid", "idempotent_replay", "exempt"],
        required: true,
    },
    amountZns: { type: Number, default: null },
    amountUsd: { type: String, default: null },
    tokenPriceUsd: { type: Number, default: null },
    trigger: { type: String, default: null },
    quoteId: { type: String, default: null },
    at: { type: Date, required: true },
});

zelfIdMonthlyAccessAuditSchema.index({ zelfName: 1, periodKey: 1, at: -1 });

addBasicPlugins(zelfIdMonthlyAccessAuditSchema);

const ZelfIdMonthlyAccessAudit =
    mongoose.models.ZelfIdMonthlyAccessAudit || mongoose.model("ZelfIdMonthlyAccessAudit", zelfIdMonthlyAccessAuditSchema);

module.exports = ZelfIdMonthlyAccessAudit;
