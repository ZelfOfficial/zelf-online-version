const mongoose = require("mongoose");

const Schema = mongoose.Schema;
const { addBasicPlugins } = require("../../../Core/mongoose-utils");

/**
 * Successful LI.FI swap executions for one Zelf ID in one UTC month (`YYYY-MM`).
 * Failed requests are released and do not stay in `count`.
 */
const zelfIdSwapUsageSchema = new Schema({
    zelfName: { type: String, required: true },
    domain: { type: String, required: true },
    tagName: { type: String, required: true },
    periodKey: { type: String, required: true },
    count: { type: Number, required: true, default: 0, min: 0 },
});

zelfIdSwapUsageSchema.index({ zelfName: 1, periodKey: 1 }, { unique: true });

addBasicPlugins(zelfIdSwapUsageSchema);

const ZelfIdSwapUsage = mongoose.models.ZelfIdSwapUsage || mongoose.model("ZelfIdSwapUsage", zelfIdSwapUsageSchema);

module.exports = ZelfIdSwapUsage;
