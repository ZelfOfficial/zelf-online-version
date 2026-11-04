const mongoose = require("mongoose");

const faceReplayDigestSchema = new mongoose.Schema(
    {
        digest: { type: String, required: true, trim: true, maxlength: 128 },
        identifier: { type: String, required: true, trim: true, maxlength: 512 },
        action: { type: String, required: true, trim: true, maxlength: 64 },
        expiresAt: { type: Date, required: true, expires: 0 },
    },
    { timestamps: true, collection: "FaceReplayDigests" }
);

faceReplayDigestSchema.index({ digest: 1, identifier: 1, action: 1 }, { unique: true });

module.exports = mongoose.model("FaceReplayDigest", faceReplayDigestSchema);
