const mongoose = require("mongoose");

const rewardsSchema = new mongoose.Schema(
	{
		rewardPrimaryKey: {
			type: String,
			required: true,
			unique: true,
		},
		name: {
			type: String,
			required: true,
			index: true,
		},
		amount: {
			type: Number,
			required: true,
		},
		type: {
			type: String,
			required: true,
			enum: ["daily", "referral", "bonus", "achievement"],
		},
		status: {
			type: String,
			default: "claimed",
			enum: ["pending", "processing", "claimed", "expired", "failed"],
		},
		// Signature and lock for an in-flight daily payout. The day is "claimed" only after that payout is confirmed.
		payload: {
			type: mongoose.Schema.Types.Mixed,
		},
		failReason: {
			type: String,
			optional: true,
		},
		description: {
			type: String,
			optional: true,
		},
		rewardDate: {
			type: Date,
			required: true,
			default: Date.now,
		},
		redeemedAt: {
			type: Date,
			optional: true,
		},
		zelfNameType: {
			type: String,
			required: true,
			enum: ["hold", "mainnet"],
		},
		ipfsCid: {
			type: String,
			optional: true,
		},
		metadata: {
			type: mongoose.Schema.Types.Mixed,
			optional: true,
		},
		// TTL field - documents will be automatically deleted after 5 minutes
		expiresAt: {
			type: Date,
			default: Date.now,
			expires: 300, // 5 minutes in seconds
		},
	},
	{
		timestamps: true,
	}
);

// Indexes
rewardsSchema.index({ name: 1, type: 1 });
rewardsSchema.index({ name: 1, status: 1 });
rewardsSchema.index({ createdAt: -1 });

module.exports = mongoose.model("Rewards", rewardsSchema);
