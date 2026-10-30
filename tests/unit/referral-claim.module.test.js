/**
 * Referral list and claim (#514, #515). The chain, Pinata, Arweave and Mongo are replaced by
 * in-memory fakes: these paths move real tokens, so no test may reach a real network.
 */
jest.mock("../../Repositories/Tags/config/supported-domains", () => ({
	getDomainConfig: jest.fn(),
	loadDynamicDomains: jest.fn(),
}));
jest.mock("../../Repositories/Tags/modules/tags-search.module", () => ({ searchIPFS: jest.fn(), searchArweave: jest.fn() }));
jest.mock("../../Repositories/Tags/modules/tags.module", () => ({ searchTag: jest.fn() }));
jest.mock("../../Repositories/Tags/modules/referral-reward-transfer", () => ({
	sendRewardTransfer: jest.fn(),
	getRewardTransferOutcome: jest.fn(),
}));
jest.mock("../../Core/ipfs", () => ({ filter: jest.fn(), pinFile: jest.fn() }));
jest.mock("../../Repositories/Tags/modules/tags-arweave.module", () => ({ receiptRegistration: jest.fn() }));
jest.mock("../../Repositories/bitcoin/modules/bitcoin-scrapping.module", () => ({}));
jest.mock("../../Repositories/etherscan/modules/etherscan-scrapping.module", () => ({}));
jest.mock("../../Repositories/Solana/modules/solana-scrapping.module", () => ({}));
jest.mock("../../Repositories/Avalanche/modules/avalanche-scrapping.module", () => ({}));
jest.mock("../../Repositories/BlockDAG/modules/blockdag.module", () => ({}));
jest.mock("../../Core/mailgun", () => ({ sendCustomEmail: jest.fn() }));
jest.mock("../../Repositories/Tags/modules/tags-payment.module", () => ({}));
jest.mock("../../Repositories/Tags/modules/tag-pay-session-tx.util", () => ({}));
jest.mock("../../Repositories/Tags/modules/tag-smart-contract-payment.module", () => ({}));
jest.mock("../../Repositories/License/modules/license.module", () => ({}));

jest.mock("../../Repositories/Tags/models/referral-rewards.model", () => {
	const store = [];
	const clone = (value) => JSON.parse(JSON.stringify(value));
	const read = (doc, path) => path.split(".").reduce((value, key) => (value == null ? undefined : value[key]), doc);
	const matches = (doc, filter) =>
		Object.entries(filter).every(([path, expected]) => {
			const value = read(doc, path);
			if (expected && typeof expected === "object" && Array.isArray(expected.$in)) return expected.$in.includes(value);
			return value === expected;
		});
	const unset = (doc, path) => {
		const keys = path.split(".");
		const parent = keys.slice(0, -1).reduce((value, key) => (value == null ? undefined : value[key]), doc);
		if (parent) delete parent[keys[keys.length - 1]];
	};

	class FakeReferralReward {
		constructor(data) {
			Object.assign(this, clone(data));
			this._id = this._id || `reward-${store.length + 1}`;
			this.isNew = true;
		}

		async save() {
			const { isNew, ...data } = this;
			const index = store.findIndex((doc) => doc._id === this._id);
			if (index >= 0) store[index] = clone(data);
			else store.push(clone(data));
			this.isNew = false;
			return this;
		}

		static hydrate(doc) {
			const record = new FakeReferralReward(doc);
			record.isNew = false;
			return record;
		}

		static async find(filter) {
			return store.filter((doc) => matches(doc, filter)).map((doc) => FakeReferralReward.hydrate(doc));
		}

		static async updateOne(filter, update) {
			const doc = store.find((candidate) => matches(candidate, filter));
			if (!doc) return { modifiedCount: 0 };
			Object.assign(doc, clone(update.$set || {}));
			Object.keys(update.$unset || {}).forEach((path) => unset(doc, path));
			return { modifiedCount: 1 };
		}
	}

	FakeReferralReward.store = store;
	return FakeReferralReward;
});

const { getDomainConfig, loadDynamicDomains } = require("../../Repositories/Tags/config/supported-domains");
const TagsSearchModule = require("../../Repositories/Tags/modules/tags-search.module");
const { searchTag } = require("../../Repositories/Tags/modules/tags.module");
const RewardTransfer = require("../../Repositories/Tags/modules/referral-reward-transfer");
const IPFS = require("../../Core/ipfs");
const TagsArweaveModule = require("../../Repositories/Tags/modules/tags-arweave.module");
const ReferralRewardModel = require("../../Repositories/Tags/models/referral-rewards.model");
const Module = require("../../Repositories/Tags/modules/my-tags.module");

const ZELF = { name: "zelf", tags: { storage: { ipfsEnabled: true, arweaveEnabled: true } }, getPrice: () => ({ price: 0 }) };
const REFERRER_ADDRESS = "E5zQvcpuRdtcwZfRxBKHLgnUQRf6wCsYBf75Lix5upEG";

/** Production records for qa99.zelf on 2026-10-01: one Arweave (mainnet) and two IPFS (hold). */
const referralRecords = () => [
	{ id: "arweave-2026qa", publicData: { zelfName: "2026qa.zelf", domain: "zelf", referralTagName: "qa99.zelf", type: "mainnet", price: 0 }, name: "2026qa.zelf" },
	{ id: "ipfs-qa94", publicData: { tagName: "qa94.zelf.hold", zelfName: "qa94.zelf.hold", domain: "zelf", referralTagName: "qa99.zelf", type: "hold" } },
	{ id: "ipfs-qa95", publicData: { tagName: "qa95.zelf.hold", zelfName: "qa95.zelf.hold", domain: "zelf", referralTagName: "qa99.zelf", type: "hold" } },
];

const claim = (friendTagName = "2026qa") => Module.claimReferralReward("qa99", "zelf", friendTagName, "zelf", {}, "registration");
const recordFor = (friendKey) => ReferralRewardModel.store.find((doc) => doc.tagName === friendKey);
const byName = (referrals, name) => referrals.find((item) => item.name === name);
const confirmedWith = (signature) => async (_amount, _address, { onSigned }) => {
	await onSigned({ signature, lastValidBlockHeight: 1000 });
	return { state: "confirmed", signature, lastValidBlockHeight: 1000 };
};

beforeEach(() => {
	jest.clearAllMocks();
	ReferralRewardModel.store.length = 0;
	getDomainConfig.mockReturnValue(ZELF);
	loadDynamicDomains.mockResolvedValue({ zelf: ZELF });
	// Like the real searches: a missing domain config reads as "storage disabled" and finds nothing.
	TagsSearchModule.searchIPFS.mockImplementation(async ({ domainConfig }) => (domainConfig?.tags?.storage?.ipfsEnabled ? referralRecords().slice(1) : []));
	TagsSearchModule.searchArweave.mockImplementation(async ({ domainConfig }) => (domainConfig?.tags?.storage?.arweaveEnabled ? referralRecords().slice(0, 1) : []));
	searchTag.mockResolvedValue({ available: false, tagObject: { publicData: { solanaAddress: REFERRER_ADDRESS, ethAddress: "0xabc" } } });
	IPFS.filter.mockResolvedValue([]);
	IPFS.pinFile.mockResolvedValue({ IpfsHash: "bafy-receipt" });
	TagsArweaveModule.receiptRegistration.mockResolvedValue({ id: "arweave-receipt" });
	RewardTransfer.getRewardTransferOutcome.mockResolvedValue({ state: "pending" });
});

describe("referral list (#514)", () => {
	test("waits for the expired license cache instead of answering an empty list", async () => {
		let reloaded = false;
		getDomainConfig.mockImplementation(() => (reloaded ? ZELF : null));
		loadDynamicDomains.mockImplementation(async () => {
			reloaded = true;
			return { zelf: ZELF };
		});

		const { referrals } = await Module.getMyReferrals("qa99", "zelf", {});

		expect(loadDynamicDomains).toHaveBeenCalledTimes(1);
		expect(TagsSearchModule.searchIPFS.mock.calls[0][0].domainConfig).toBe(ZELF);
		expect(referrals.map((item) => item.name).sort()).toEqual(["2026qa.zelf", "qa94.zelf", "qa95.zelf"]);
	});

	test("reports the outage when the licenses cannot be loaded", async () => {
		getDomainConfig.mockReturnValue(null);
		loadDynamicDomains.mockResolvedValue(null);

		await expect(Module.getMyReferrals("qa99", "zelf", {})).rejects.toMatchObject({ status: 503, message: "domain_config_unavailable" });
		expect(TagsSearchModule.searchIPFS).not.toHaveBeenCalled();
	});

	test("an unknown domain is a bad request, not an outage", async () => {
		getDomainConfig.mockImplementation((name) => (name === "zelf" ? ZELF : null));

		await expect(Module.getMyReferrals("qa99", "nope", {})).rejects.toThrow("400:domain_not_supported");
	});

	test("a stuck claim keeps its wallet in the list", async () => {
		// TagsReferralReward 6abec67e529166bce08228f7 as stored in production.
		ReferralRewardModel.store.push({
			_id: "6abec67e529166bce08228f7",
			tagName: "2026qa.zelf.hold",
			referralTagName: "qa99.zelf",
			status: "processing",
			attempts: 1,
			rewardType: "registration",
			payload: { error: "Transaction 5tbM4Nn… was not confirmed after 10 polls (90s timeout)", requiresReconciliation: true },
		});

		const { referrals, totalEarnedInZNS } = await Module.getMyReferrals("qa99", "zelf", {});

		expect(referrals).toHaveLength(3);
		expect(byName(referrals, "2026qa.zelf")).toMatchObject({ claimStatus: "processing", claimed: false });
		expect(totalEarnedInZNS).toBe(0);
		// Without a stored transfer signature only a person can decide it.
		expect(RewardTransfer.getRewardTransferOutcome).not.toHaveBeenCalled();
		expect(recordFor("2026qa.zelf.hold").status).toBe("processing");
	});

	test("a failed receipt lookup is an error, never an empty list", async () => {
		IPFS.filter.mockRejectedValue(new Error("pinata 429"));

		await expect(Module.getMyReferrals("qa99", "zelf", {})).rejects.toThrow("pinata 429");
	});
});

describe("referral claim (#515)", () => {
	test("a transfer that never left the server releases the reservation for a retry", async () => {
		RewardTransfer.sendRewardTransfer.mockRejectedValueOnce(new Error("rewards_wallet_insufficient_balance"));

		await expect(claim()).rejects.toMatchObject({ status: 503, code: "reward_transfer_not_sent" });
		expect(recordFor("2026qa.zelf.hold")).toMatchObject({ status: "failed", attempts: 1 });

		RewardTransfer.sendRewardTransfer.mockImplementationOnce(confirmedWith("sig-retry"));

		await expect(claim()).resolves.toMatchObject({ success: true, rewardAmount: 10, signature: "sig-retry" });
		expect(recordFor("2026qa.zelf.hold")).toMatchObject({ status: "completed" });
		expect(recordFor("2026qa.zelf.hold").payload.signature).toBe("sig-retry");
	});

	test("an unconfirmed transfer stays reserved with its signature and is never sent twice", async () => {
		RewardTransfer.sendRewardTransfer.mockImplementationOnce(async (_amount, address, { onSigned }) => {
			expect(address).toBe(REFERRER_ADDRESS);
			await onSigned({ signature: "sig-1", lastValidBlockHeight: 1000 });
			// The signature is stored before the broadcast.
			expect(recordFor("2026qa.zelf.hold")).toMatchObject({ status: "processing" });
			expect(recordFor("2026qa.zelf.hold").payload).toMatchObject({ transferSignature: "sig-1", lastValidBlockHeight: 1000 });
			return { state: "pending", signature: "sig-1", lastValidBlockHeight: 1000 };
		});

		await expect(claim()).resolves.toMatchObject({ success: false, pending: true, status: "processing", message: "reward_transfer_pending" });

		// Still in flight: a second tap is refused.
		await expect(claim()).rejects.toThrow("reward_claim_in_progress");

		// The chain confirms it later: the list settles the claim.
		RewardTransfer.getRewardTransferOutcome.mockResolvedValue({ state: "confirmed" });
		const { referrals, totalEarnedInZNS } = await Module.getMyReferrals("qa99", "zelf", {});

		expect(RewardTransfer.getRewardTransferOutcome).toHaveBeenCalledWith({ signature: "sig-1", lastValidBlockHeight: 1000 });
		expect(byName(referrals, "2026qa.zelf")).toMatchObject({ claimed: true, claimStatus: "completed", rewardAmount: 10 });
		expect(totalEarnedInZNS).toBe(10);
		await expect(claim()).rejects.toThrow("reward_already_claimed");
		expect(RewardTransfer.sendRewardTransfer).toHaveBeenCalledTimes(1);
	});

	test("an expired transfer is released and the retry signs a new one", async () => {
		RewardTransfer.sendRewardTransfer.mockImplementationOnce(async (_amount, _address, { onSigned }) => {
			await onSigned({ signature: "sig-old", lastValidBlockHeight: 1000 });
			return { state: "pending", signature: "sig-old", lastValidBlockHeight: 1000 };
		});
		await claim();

		RewardTransfer.getRewardTransferOutcome.mockResolvedValue({ state: "expired" });
		const { referrals } = await Module.getMyReferrals("qa99", "zelf", {});

		expect(byName(referrals, "2026qa.zelf")).toMatchObject({ claimStatus: "failed", claimed: false });
		expect(recordFor("2026qa.zelf.hold").payload).toMatchObject({ error: "reward_transfer_expired", requiresReconciliation: false });

		RewardTransfer.sendRewardTransfer.mockImplementationOnce(confirmedWith("sig-new"));
		await expect(claim()).resolves.toMatchObject({ success: true, signature: "sig-new" });
		expect(RewardTransfer.sendRewardTransfer).toHaveBeenCalledTimes(2);
	});

	test("a reconciliation of the previous attempt cannot release the new reservation", async () => {
		ReferralRewardModel.store.push({
			_id: "reward-old",
			tagName: "2026qa.zelf.hold",
			referralTagName: "qa99.zelf",
			status: "failed",
			attempts: 1,
			rewardType: "registration",
			payload: { transferSignature: "sig-old", lastValidBlockHeight: 900 },
		});
		RewardTransfer.getRewardTransferOutcome.mockResolvedValue({ state: "expired" });

		RewardTransfer.sendRewardTransfer.mockImplementationOnce(async (_amount, _address, { onSigned }) => {
			// A list request lands while this claim holds the reservation.
			await Module.getMyReferrals("qa99", "zelf", {});
			expect(recordFor("2026qa.zelf.hold").status).toBe("processing");
			await onSigned({ signature: "sig-new", lastValidBlockHeight: 1000 });
			return { state: "confirmed", signature: "sig-new", lastValidBlockHeight: 1000 };
		});

		await expect(claim()).resolves.toMatchObject({ success: true, signature: "sig-new" });
		expect(recordFor("2026qa.zelf.hold")).toMatchObject({ status: "completed" });
		expect(recordFor("2026qa.zelf.hold").payload.signature).toBe("sig-new");
	});

	test("a transfer that failed on chain is reported and can be retried", async () => {
		RewardTransfer.sendRewardTransfer.mockImplementationOnce(async (_amount, _address, { onSigned }) => {
			await onSigned({ signature: "sig-err", lastValidBlockHeight: 1000 });
			return { state: "failed", signature: "sig-err", error: '{"InstructionError":[2,{"Custom":1}]}' };
		});

		await expect(claim()).rejects.toMatchObject({ status: 502, code: "reward_transfer_failed" });
		expect(recordFor("2026qa.zelf.hold")).toMatchObject({ status: "failed" });
		expect(recordFor("2026qa.zelf.hold").payload.signature).toBeUndefined();
	});

	test("the legacy stuck claim of qa99 is refused until someone reconciles it", async () => {
		ReferralRewardModel.store.push({
			_id: "6abec67e529166bce08228f7",
			tagName: "2026qa.zelf.hold",
			referralTagName: "qa99.zelf",
			status: "processing",
			attempts: 1,
			rewardType: "registration",
			payload: { error: "Transaction 5tbM4Nn… was not confirmed", requiresReconciliation: true },
		});

		await expect(claim()).rejects.toThrow("reward_claim_in_progress");
		expect(RewardTransfer.sendRewardTransfer).not.toHaveBeenCalled();
	});

	test("a paid claim answers without waiting for the receipt upload", async () => {
		TagsArweaveModule.receiptRegistration.mockReturnValue(new Promise(() => {}));
		RewardTransfer.sendRewardTransfer.mockImplementationOnce(confirmedWith("sig-paid"));

		await expect(claim()).resolves.toEqual({ success: true, rewardAmount: 10, signature: "sig-paid", ipfsCid: null });
		expect(recordFor("2026qa.zelf.hold")).toMatchObject({ status: "completed" });
	});

	test("the claim waits for the license cache too", async () => {
		let reloaded = false;
		getDomainConfig.mockImplementation(() => (reloaded ? ZELF : null));
		loadDynamicDomains.mockImplementation(async () => {
			reloaded = true;
			return { zelf: ZELF };
		});
		RewardTransfer.sendRewardTransfer.mockImplementationOnce(confirmedWith("sig-cache"));

		await expect(claim("qa95")).resolves.toMatchObject({ success: true });
		expect(recordFor("qa95.zelf.hold")).toMatchObject({ status: "completed" });
	});

	test("refuses claiming an 11th referral beyond the 10-friend reward cap (#137)", async () => {
		const elevenReferrals = Array.from({ length: 11 }, (_, i) => ({
			id: `ipfs-f${i}`,
			publicData: {
				tagName: `f${i}.zelf.hold`,
				zelfName: `f${i}.zelf.hold`,
				domain: "zelf",
				referralTagName: "qa99.zelf",
				type: "hold",
				registeredAt: `2026-01-${String(i + 1).padStart(2, "0")} 00:00:00`,
			},
		}));
		TagsSearchModule.searchIPFS.mockResolvedValue(elevenReferrals);
		TagsSearchModule.searchArweave.mockResolvedValue([]);

		const list = await Module.getMyReferrals("qa99", "zelf", {});
		expect(byName(list.referrals, "f10.zelf")).toMatchObject({ countsForReward: false, claimed: false });
		expect(byName(list.referrals, "f0.zelf")).toMatchObject({ countsForReward: true, claimed: false });

		await expect(claim("f10")).rejects.toMatchObject({ status: 409, code: "referral_limit_reached" });
		expect(RewardTransfer.sendRewardTransfer).not.toHaveBeenCalled();
	});
});
