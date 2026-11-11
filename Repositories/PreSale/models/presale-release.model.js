const mongoose = require("mongoose");

const { Schema } = mongoose;

/**
 * Idempotency record for a verified presale payout.
 * tokensReleased is stored together with payoutTx, and licenseExtended together with licenseRecord.
 */
const PresaleReleaseSchema = new Schema(
    {
        sessionId: {
            type: String,
            required: true,
            unique: true,
        },
        tokensReleased: {
            type: Boolean,
            default: false,
        },
        payoutTx: {
            type: String,
            default: "",
        },
        licenseExtended: {
            type: Boolean,
            default: false,
        },
        licenseRecord: {
            type: String,
            default: "",
        },
    },
    { timestamps: true }
);

module.exports = mongoose.model("PresaleRelease", PresaleReleaseSchema);
