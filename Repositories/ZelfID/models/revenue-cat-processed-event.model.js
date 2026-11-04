const mongoose = require("mongoose");

const { addBasicPlugins } = require("../../../Core/mongoose-utils");

/**
 * One document per RevenueCat event.id that reached the crediting step.
 * The unique index on `eventId` is the cross-process lock: the same event delivered twice
 * (retries, or both the v3 forwarder and the v4 webhook) is credited at most once.
 */
const revenueCatProcessedEventSchema = new mongoose.Schema({
    eventId: { type: String, required: true },
    eventType: { type: String, default: "" },
    transactionId: { type: String, default: "" },
    originalTransactionId: { type: String, default: "" },
    productId: { type: String, default: "" },
    status: { type: String, enum: ["processing", "processed"], default: "processing" },
    claimedAt: { type: Date, default: Date.now },
    processedAt: { type: Date, default: null },
    result: { type: mongoose.Schema.Types.Mixed, default: null },
});

revenueCatProcessedEventSchema.index({ eventId: 1 }, { unique: true });
// Store-transaction dedupe: a purchase re-sent under a new event.id (v3 + v4, replays) is credited once.
revenueCatProcessedEventSchema.index({ transactionId: 1 });

addBasicPlugins(revenueCatProcessedEventSchema);

module.exports = mongoose.model("RevenueCatProcessedEvent", revenueCatProcessedEventSchema);
