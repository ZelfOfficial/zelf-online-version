const mongoose = require("mongoose");

const { Schema } = mongoose;

const FirstTransactionClaimSchema = new Schema(
    {
        tagName: {
            type: String,
            required: true,
            unique: true,
        },
        status: {
            type: String,
            enum: ["pending", "claimed", "failed"],
            default: "pending",
        },
        payoutTx: {
            type: String,
            default: "",
        },
    },
    { timestamps: true }
);

module.exports = mongoose.model("FirstTransactionClaim", FirstTransactionClaimSchema);
