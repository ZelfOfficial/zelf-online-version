const mongoose = require("mongoose");

const { addBasicPlugins } = require("../../../Core/mongoose-utils");

/**
 * One successful confirm for a signed quote. Replay looks up this row by name and quote,
 * not by comparing pin timestamps.
 */
const zelfIdQuoteGrantSchema = new mongoose.Schema({
    zelfName: { type: String, required: true, lowercase: true, trim: true },
    quoteHash: { type: String, required: true },
    source: { type: String, required: true },
    paymentMethod: { type: String, default: null },
    couponId: { type: String, default: null },
    plan: { type: String, default: null },
    duration: { type: String, default: null },
    status: { type: String, enum: ["pending", "done"], default: "pending" },
});

zelfIdQuoteGrantSchema.index({ zelfName: 1, quoteHash: 1 }, { unique: true });

addBasicPlugins(zelfIdQuoteGrantSchema);

module.exports = mongoose.models.ZelfIdQuoteGrant || mongoose.model("ZelfIdQuoteGrant", zelfIdQuoteGrantSchema);
