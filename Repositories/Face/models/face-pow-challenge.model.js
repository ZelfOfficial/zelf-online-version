const mongoose = require("mongoose");

const facePowChallengeSchema = new mongoose.Schema(
    {
        challengeId: { type: String, required: true, unique: true, trim: true, maxlength: 128 },
        salt: { type: String, required: true },
        difficulty: { type: Number, required: true },
        expiresAt: { type: Date, required: true, expires: 0 },
        signature: { type: String, required: true },
        identifier: { type: String, required: true, maxlength: 512 },
        action: { type: String, required: true, maxlength: 64 },
    },
    { timestamps: false, collection: "FacePowChallenges" }
);

module.exports = mongoose.model("FacePowChallenge", facePowChallengeSchema);
