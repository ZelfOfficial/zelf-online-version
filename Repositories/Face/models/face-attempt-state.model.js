const mongoose = require("mongoose");

/** Per-scope failure counters and lockouts (`identity`, `ip`, `device`). */
const faceAttemptStateSchema = new mongoose.Schema(
    {
        scope: { type: String, required: true, enum: ["identity", "ip", "device"], maxlength: 16 },
        key: { type: String, required: true, trim: true, maxlength: 512 },
        failureCount: { type: Number, required: true, default: 0, min: 0 },
        windowStartedAt: { type: Date, required: true },
        lockedUntil: { type: Date, default: null },
        lockoutLevel: { type: Number, default: 0, min: 0 },
        expiresAt: { type: Date, required: true, expires: 0 },
    },
    { timestamps: true, collection: "FaceAttemptStates" }
);

faceAttemptStateSchema.index({ scope: 1, key: 1 }, { unique: true });

module.exports = mongoose.model("FaceAttemptState", faceAttemptStateSchema);
