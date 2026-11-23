const mongoose = require("mongoose");

/**
 * Daily relay counters keyed by identity or client address, shared across API workers.
 * `expiresAt` is a few days after the UTC day so Mongo can drop the row.
 */
const VaultLegacyRelayUsageSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    count: { type: Number, required: true, default: 0 },
    expiresAt: { type: Date, required: true },
});

VaultLegacyRelayUsageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports =
    mongoose.models.VaultLegacyRelayUsage || mongoose.model("VaultLegacyRelayUsage", VaultLegacyRelayUsageSchema);
