const mongoose = require("mongoose");

const Schema = mongoose.Schema;
const { addBasicPlugins } = require("../../../Core/mongoose-utils");

/**
 * A non-EVM chain the owner was allowed to activate.
 * An address already stored on the Zelf ID counts as active without a row here.
 */
const zelfIdChainActivationSchema = new Schema({
    zelfName: { type: String, required: true },
    domain: { type: String, required: true },
    tagName: { type: String, required: true },
    chain: { type: String, required: true },
    activatedAt: { type: Date, required: true },
});

zelfIdChainActivationSchema.index({ zelfName: 1, chain: 1 }, { unique: true });

addBasicPlugins(zelfIdChainActivationSchema);

const ZelfIdChainActivation =
    mongoose.models.ZelfIdChainActivation || mongoose.model("ZelfIdChainActivation", zelfIdChainActivationSchema);

module.exports = ZelfIdChainActivation;
