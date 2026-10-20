const mongoose = require("mongoose");

const faceNonceSchema = new mongoose.Schema(
    {
        nonce: { type: String, required: true, unique: true, trim: true, maxlength: 128 },
        action: { type: String, required: true, trim: true, maxlength: 64 },
        identifier: { type: String, required: true, trim: true, maxlength: 512 },
        sessionKey: { type: String, required: true, trim: true, maxlength: 128 },
        usedAt: { type: Date, default: null },
        expiresAt: { type: Date, required: true, expires: 0 },
    },
    { timestamps: true, collection: "FaceNonces" }
);

faceNonceSchema.index({ identifier: 1, action: 1, sessionKey: 1 });

module.exports = mongoose.model("FaceNonce", faceNonceSchema);
