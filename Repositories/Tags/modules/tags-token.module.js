const RewardTransfer = require("./referral-reward-transfer");
const { assertPayoutAddressAllowed, isPayoutAddressBlocked } = require("../../ZelfNameService/modules/zns-payout-denylist");
const ReferralRewardModel = require("../models/referral-rewards.model");
const PurchaseRewardModel = require("../models/purchase-rewards.model");
const MongoORM = require("../../../Core/mongo-orm");

/**
 * Tags reward records and the purchase reward release.
 *
 * The ZNS transfer goes through referral-reward-transfer (one transaction that creates the
 * receiver's token account if needed and transfers, priority fee, signed once, signature stored
 * before the broadcast, outcome read from the chain). The previous sender here created the
 * account in its own transaction without a priority fee, re-signed the transfer after about
 * 38 s while the first could still land (paying twice), and read amounts under 1000 as tokens
 * but 1000 or more as base units (a 1500 ZNS reward sent 0.000015 ZNS).
 *
 * Referral rewards are paid per referral by the claim flow (my-tags.module claimReferralReward);
 * the old batch that paid 5% of grouped prices from the same collection is gone (/referral-rewards
 * answers 410).
 */

/** Sends that did not pay before a purchase reward is marked failed for a person to review. */
const MAX_PURCHASE_REWARD_ATTEMPTS = 5;

const _rewardError = (status, code) => {
	const err = new Error(code);
	err.status = status;
	err.code = code;
	return err;
};

const addReferralReward = async (tagObject, authUser, domain = "zelf") => {
	if (!tagObject) return null;

	try {
		const referralReward = new ReferralRewardModel({
			tagName: tagObject.tagName,
			domain: domain,
			ethAddress: tagObject.ethAddress,
			solanaAddress: tagObject.solanaAddress,
			referralTagName: tagObject.referralTagName,
			referralDomain: tagObject.referralDomain || domain,
			referralSolanaAddress: tagObject.referralSolanaAddress,
			tagPrice: tagObject.tagPrice || 0,
			status: "pending",
			attempts: 0,
			payload: {},
			ipfsHash: tagObject.ipfsHash,
			arweaveId: tagObject.arweaveId,
		});

		await referralReward.save();

		return referralReward;
	} catch (error) {
		console.error("Error adding referral reward:", error);
	}
};

const addPurchaseReward = async (authUser, domain = "zelf", tagPrice = 0) => {
	if (!authUser) return null;

	try {
		const purchaseReward = new PurchaseRewardModel({
			tagName: `${authUser.email}_${domain}_${Date.now()}`, // Generate unique tag name
			domain: domain,
			ethAddress: authUser.ethAddress || "",
			solanaAddress: authUser.solanaAddress || "",
			tagPrice: tagPrice,
			tokenAmount: 250, // whole ZNS (Math.round(tagPrice / config.token.rewardPrice))
			status: "pending",
			attempts: 0,
			payload: {},
			ipfsHash: "",
			arweaveId: "not_set",
		});

		return await purchaseReward.save();
	} catch (error) {
		console.error("Error adding purchase reward:", error);
		throw error; // Re-throw for higher-level error handling if needed
	}
};

/** The record's reward in whole ZNS. Never base units. */
const _purchaseRewardTokens = (record) => {
	const tokens = Number(record?.tokenAmount);
	return Number.isFinite(tokens) && tokens > 0 ? tokens : null;
};

const _summary = (record, changes = {}) => ({
	_id: record._id,
	tagName: record.tagName,
	domain: record.domain,
	solanaAddress: record.solanaAddress,
	tokenAmount: record.tokenAmount,
	status: record.status,
	attempts: record.attempts,
	payload: record.payload,
	...changes,
});

/**
 * Settles purchase rewards left "processing" from the signature stored before their broadcast.
 * Confirmed -> completed. Failed on chain or expired (nothing moved) -> pending again, or failed
 * once the attempts are used up. Still able to land -> left alone, so it is never re-signed.
 * Records without a stored signature are left for a person.
 */
const _settleProcessingPurchaseRewards = async () => {
	const processing = await PurchaseRewardModel.find({ status: "processing" });

	for (const record of processing) {
		const signature = record.payload?.transferSignature;

		if (!signature) continue;

		let outcome;

		try {
			outcome = await RewardTransfer.getRewardTransferOutcome({ signature, lastValidBlockHeight: record.payload.lastValidBlockHeight });
		} catch (error) {
			console.error("Purchase reward reconciliation failed:", signature, error?.message || error);
			continue;
		}

		let $set;

		if (outcome.state === "confirmed") {
			$set = {
				status: "completed",
				completedAt: new Date(),
				payload: { ...record.payload, signature, requiresReconciliation: false, error: null, reconciledAt: new Date().toISOString() },
			};
		} else if (outcome.state === "failed" || outcome.state === "expired") {
			$set = {
				status: record.attempts >= MAX_PURCHASE_REWARD_ATTEMPTS ? "failed" : "pending",
				payload: {
					...record.payload,
					requiresReconciliation: false,
					error: outcome.state === "expired" ? "reward_transfer_expired" : outcome.error || "reward_transfer_failed",
					reconciledAt: new Date().toISOString(),
				},
			};
		} else {
			continue;
		}

		await PurchaseRewardModel.updateOne({ _id: record._id, status: "processing", "payload.transferSignature": signature }, { $set });
	}
};

/**
 * Releases the oldest pending Tags purchase reward (super admin, one record per call).
 * 1. Settle "processing" records from the chain.
 * 2. Reserve the next "pending" record atomically (a concurrent call cannot take the same one)
 *    and drop the previous attempt's signature in the same update.
 * 3. Store the signature, then broadcast one signed transaction of `tokenAmount` whole ZNS.
 * 4. Confirmed -> completed with the signature. Not confirmed yet -> stays "processing" and is
 *    settled by a later call (`pending: true`). Failed on chain -> pending again (502). Nothing
 *    broadcast -> pending again (503).
 * @returns {Promise<Object>} The record summary, or { nothingToProcess: true }
 */
const releasePurchaseRewards = async () => {
	await _settleProcessingPurchaseRewards();

	const purchaseReward = await PurchaseRewardModel.findOneAndUpdate(
		{ status: "pending" },
		{ $set: { status: "processing" }, $unset: { "payload.transferSignature": "", "payload.lastValidBlockHeight": "" } },
		{ sort: { createdAt: 1 }, new: true }
	);

	if (!purchaseReward) return { nothingToProcess: true };

	const reserved = { _id: purchaseReward._id, status: "processing" };
	const attempts = (purchaseReward.attempts || 0) + 1;
	const payload = { ...(purchaseReward.payload || {}) };

	if ((purchaseReward.attempts || 0) >= MAX_PURCHASE_REWARD_ATTEMPTS) {
		await PurchaseRewardModel.updateOne(reserved, { $set: { status: "failed", completedAt: new Date() } });
		return _summary(purchaseReward, { status: "failed" });
	}

	const tokens = _purchaseRewardTokens(purchaseReward);

	if (!tokens) {
		const failedPayload = { ...payload, error: "invalid_reward_amount", requiresReconciliation: false };
		await PurchaseRewardModel.updateOne(reserved, { $set: { status: "failed", payload: failedPayload } });
		return _summary(purchaseReward, { status: "failed", payload: failedPayload });
	}

	if (isPayoutAddressBlocked(purchaseReward.solanaAddress)) {
		const failedPayload = { ...payload, error: "PAYOUT_ADDRESS_BLOCKED", requiresReconciliation: false };
		await PurchaseRewardModel.updateOne(reserved, { $set: { status: "failed", attempts, payload: failedPayload } });
		assertPayoutAddressAllowed(purchaseReward.solanaAddress);
	}

	let storedSignature = null;
	let transfer;

	try {
		transfer = await RewardTransfer.sendRewardTransfer(tokens, purchaseReward.solanaAddress, {
			onSigned: async ({ signature, lastValidBlockHeight }) => {
				Object.assign(payload, { transferSignature: signature, lastValidBlockHeight, tokenAmount: tokens, requiresReconciliation: true, error: null });

				// Only while this call still holds the reservation; otherwise nothing is broadcast.
				const stored = await PurchaseRewardModel.updateOne(reserved, { $set: { payload } });

				if (stored.modifiedCount !== 1) throw new Error("reward_reservation_lost");

				storedSignature = signature;
			},
		});
	} catch (error) {
		console.error("Error releasing purchase reward:", error?.message || error);

		if (storedSignature) {
			// Not expected (the sender does not throw after the signature is stored). The transfer
			// may be on the network: keep the reservation for reconciliation.
			payload.error = error?.message || "reward_transfer_unknown";
			await PurchaseRewardModel.updateOne(reserved, { $set: { attempts, payload } });
			return _summary(purchaseReward, { attempts, payload, pending: true, signature: storedSignature });
		}

		if (error?.message === "reward_reservation_lost") throw _rewardError(409, "reward_claim_in_progress");

		// Nothing reached the network: release the reservation so a later call retries it.
		const status = attempts >= MAX_PURCHASE_REWARD_ATTEMPTS ? "failed" : "pending";
		Object.assign(payload, { error: error?.message || "reward_transfer_not_sent", requiresReconciliation: false });
		delete payload.transferSignature;
		delete payload.lastValidBlockHeight;
		await PurchaseRewardModel.updateOne(reserved, { $set: { status, attempts, payload } });

		throw _rewardError(503, "reward_transfer_not_sent");
	}

	const settled = { ...reserved, "payload.transferSignature": transfer.signature };

	if (transfer.state === "confirmed") {
		Object.assign(payload, { signature: transfer.signature, requiresReconciliation: false, error: null });
		await PurchaseRewardModel.updateOne(settled, { $set: { status: "completed", completedAt: new Date(), attempts, payload } });
		return _summary(purchaseReward, { status: "completed", attempts, payload, signature: transfer.signature });
	}

	if (transfer.state === "failed") {
		// A transaction that failed on chain moved nothing: safe to retry.
		console.error("Purchase reward transfer failed on chain:", transfer.signature, transfer.error);
		Object.assign(payload, { error: transfer.error || "reward_transfer_failed", requiresReconciliation: false });
		await PurchaseRewardModel.updateOne(settled, {
			$set: { status: attempts >= MAX_PURCHASE_REWARD_ATTEMPTS ? "failed" : "pending", attempts, payload },
		});
		throw _rewardError(502, "reward_transfer_failed");
	}

	// Unknown yet: stays reserved with its signature; a later call settles it from the chain.
	console.warn("Purchase reward transfer not confirmed yet, kept for reconciliation:", transfer.signature, transfer.error || "");
	payload.error = transfer.error || null;
	await PurchaseRewardModel.updateOne(settled, { $set: { attempts, payload } });

	return _summary(purchaseReward, { attempts, payload, pending: true, signature: transfer.signature });
};

const getPurchaseReward = async (tagName, afterDate) => {
	if (!tagName) return null;

	const queryParams = {
		where_tagName: tagName,
		findOne: true,
	};

	if (afterDate) queryParams["where>=_createdAt"] = afterDate;

	try {
		const purchaseReward = await MongoORM.buildQuery(queryParams, PurchaseRewardModel, null);

		if (!purchaseReward) return null;

		return purchaseReward;
	} catch (error) {
		console.error("Error getting purchase reward:", error);
		throw error; // Re-throw for higher-level error handling if needed
	}
};

module.exports = {
	getPurchaseReward,
	addReferralReward,
	addPurchaseReward,
	releasePurchaseRewards,
	MAX_PURCHASE_REWARD_ATTEMPTS,
};
