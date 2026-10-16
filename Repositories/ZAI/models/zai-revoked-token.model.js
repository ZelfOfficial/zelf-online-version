const mongoose = require("mongoose");

/** Denylist of revoked identity/zAI token ids. Entries expire (TTL) when the token would have expired anyway. */
const ZaiRevokedTokenSchema = new mongoose.Schema(
    {
        jti: { type: String, required: true, unique: true },
        typ: { type: String, enum: ["identity", "zai"], required: true },
        sub: { type: String, default: "" },
        expiresAt: { type: Date, required: true },
    },
    { timestamps: true }
);

ZaiRevokedTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.ZaiRevokedToken || mongoose.model("ZaiRevokedToken", ZaiRevokedTokenSchema, "zai_revoked_tokens");
