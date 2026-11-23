const mongoose = require("mongoose");

/**
 * Single-use vault-legacy session challenges.
 * Shared across API workers. Mongo deletes the document at `expiresAt`.
 */
const VaultLegacySessionChallengeSchema = new mongoose.Schema({
    challengeId: { type: String, required: true, unique: true },
    identifier: { type: String, required: true },
    address: { type: String, required: true },
    nonce: { type: String, required: true },
    message: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
});

VaultLegacySessionChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports =
    mongoose.models.VaultLegacySessionChallenge ||
    mongoose.model("VaultLegacySessionChallenge", VaultLegacySessionChallengeSchema);
