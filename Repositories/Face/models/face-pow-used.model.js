const mongoose = require("mongoose");

const facePowUsedSchema = new mongoose.Schema(
    {
        challengeId: { type: String, required: true, unique: true, trim: true, maxlength: 128 },
        expiresAt: { type: Date, required: true, expires: 0 },
    },
    { timestamps: false, collection: "FacePowUsed" }
);

module.exports = mongoose.model("FacePowUsed", facePowUsedSchema);
