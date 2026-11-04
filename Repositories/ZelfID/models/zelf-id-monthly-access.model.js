const mongoose = require("mongoose");

const Schema = mongoose.Schema;
const { addBasicPlugins } = require("../../../Core/mongoose-utils");

/**
 * One Free-plan monthly access row per Zelf ID per UTC month.
 * `reserving` is the in-flight claim; clients see `grace` or `paid`.
 * Absent row means the month had no triggering open.
 */
const zelfIdMonthlyAccessSchema = new Schema({
    zelfName: { type: String, required: true },
    domain: { type: String, required: true },
    tagName: { type: String, required: true },
    periodKey: { type: String, required: true },
    status: { type: String, enum: ["reserving", "grace", "paid"], required: true },
    amountZns: { type: Number, required: true },
    amountUsd: { type: String, required: true },
    tokenPriceUsd: { type: Number, required: true },
    premiumYearlyUsd: { type: Number, required: true },
    floorUsd: { type: Number, required: true },
    trigger: { type: String, required: true },
    quoteId: { type: String, required: true },
    settlement: { type: String, enum: ["zns", "card"] },
    graceAt: { type: Date, default: null },
    chargedAt: { type: Date, default: null },
});

zelfIdMonthlyAccessSchema.index({ zelfName: 1, periodKey: 1 }, { unique: true });

addBasicPlugins(zelfIdMonthlyAccessSchema);

const ZelfIdMonthlyAccess =
    mongoose.models.ZelfIdMonthlyAccess || mongoose.model("ZelfIdMonthlyAccess", zelfIdMonthlyAccessSchema);

module.exports = ZelfIdMonthlyAccess;
