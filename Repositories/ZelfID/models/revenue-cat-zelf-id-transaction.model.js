const mongoose = require("mongoose");

const { addBasicPlugins } = require("../../../Core/mongoose-utils");

/**
 * RevenueCat original_transaction_id → Zelf ID it pays for.
 * RENEWAL / EXPIRATION / PRODUCT_CHANGE resolve the name from here, not from
 * subscriber attributes (which follow whatever name the app touched last).
 */
const revenueCatZelfIdTransactionSchema = new mongoose.Schema({
    originalTransactionId: { type: String, required: true, unique: true, index: true },
    tagName: { type: String, required: true },
    domain: { type: String, required: true, default: "zelf" },
    ethAddress: { type: String, default: "" },
    appUserId: { type: String, default: "" },
    productId: { type: String, default: "" },
    plan: { type: String, default: "" },
    subscription: { type: Boolean, default: false },
    environment: { type: String, default: "" },
    lastEventId: { type: String, default: "" },
    lastEventType: { type: String, default: "" },
    status: { type: String, default: "active" },
});

addBasicPlugins(revenueCatZelfIdTransactionSchema);

module.exports = mongoose.model("RevenueCatZelfIdTransaction", revenueCatZelfIdTransactionSchema);
