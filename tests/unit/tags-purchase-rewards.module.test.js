/**
 * Tags purchase reward release (2026-10-01 audit). The chain and Mongo are in-memory fakes:
 * this path moves real tokens, so no test may reach a real network.
 */
jest.mock("../../Repositories/Tags/modules/referral-reward-transfer", () => ({
	sendRewardTransfer: jest.fn(),
	getRewardTransferOutcome: jest.fn(),
}));
jest.mock("../../Repositories/Tags/models/referral-rewards.model", () => function FakeReferralReward() {});
jest.mock("../../Core/mongo-orm", () => ({ buildQuery: jest.fn() }));

jest.mock("../../Repositories/Tags/models/purchase-rewards.model", () => {
	const store = [];
	const clone = (value) => JSON.parse(JSON.stringify(value));
	const read = (doc, path) => path.split(".").reduce((value, key) => (value == null ? undefined : value[key]), doc);
	const matches = (doc, filter) => Object.entries(filter).every(([path, expected]) => read(doc, path) === expected);
	const unset = (doc, path) => {
		const keys = path.split(".");
		const parent = keys.slice(0, -1).reduce((value, key) => (value == null ? undefined : value[key]), doc);
		if (parent) delete parent[keys[keys.length - 1]];
	};
	const apply = (doc, update) => {
		Object.assign(doc, clone(update.$set || {}));
		Object.keys(update.$unset || {}).forEach((path) => unset(doc, path));
	};

	// Each operation reads and writes without awaiting in between, like a single Mongo command.
	const FakePurchaseReward = {
		store,
		async find(filter) {
			return store.filter((doc) => matches(doc, filter)).map(clone);
		},
		async findOneAndUpdate(filter, update, options = {}) {
			const key = Object.keys(options.sort || {})[0];
			const candidates = store.filter((doc) => matches(doc, filter));
			if (key) candidates.sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * options.sort[key]);
			const doc = candidates[0];
			if (!doc) return null;
			apply(doc, update);
			return clone(doc);
		},
		async updateOne(filter, update) {
			const doc = store.find((candidate) => matches(candidate, filter));
			if (!doc) return { modifiedCount: 0 };
			apply(doc, update);
			return { modifiedCount: 1 };
		},
	};

	return FakePurchaseReward;
});

const RewardTransfer = require("../../Repositories/Tags/modules/referral-reward-transfer");
const PurchaseRewardModel = require("../../Repositories/Tags/models/purchase-rewards.model");
const TagsTokenModule = require("../../Repositories/Tags/modules/tags-token.module");

const RECEIVER = "E5zQvcpuRdtcwZfRxBKHLgnUQRf6wCsYBf75Lix5upEG";

const addPending = (overrides = {}) => {
	const record = {
		_id: `purchase-${PurchaseRewardModel.store.length + 1}`,
		tagName: `buyer${PurchaseRewardModel.store.length + 1}@zelf.world_zelf_1`,
		domain: "zelf",
		solanaAddress: RECEIVER,
		tokenAmount: 250,
		status: "pending",
		attempts: 0,
		payload: {},
		createdAt: `2026-10-01T00:00:0${PurchaseRewardModel.store.length}.000Z`,
		...overrides,
	};
	PurchaseRewardModel.store.push(record);
	return record;
};
const stored = (id) => PurchaseRewardModel.store.find((doc) => doc._id === id);

/** A fake sender that records what Mongo held at the moment of the broadcast. */
let broadcasts;
const sender = (state, signature, extra = {}) => async (amount, address, { onSigned }) => {
	await onSigned({ signature, lastValidBlockHeight: 1000 });
	broadcasts.push({ amount, address, signature, storedBeforeBroadcast: PurchaseRewardModel.store.map((doc) => doc.payload?.transferSignature) });
	return { state, signature, lastValidBlockHeight: 1000, ...extra };
};

beforeEach(() => {
	jest.clearAllMocks();
	jest.spyOn(console, "error").mockImplementation(() => {});
	jest.spyOn(console, "warn").mockImplementation(() => {});
	PurchaseRewardModel.store.length = 0;
	broadcasts = [];
	RewardTransfer.getRewardTransferOutcome.mockResolvedValue({ state: "pending" });
});

afterEach(() => jest.restoreAllMocks());

test("nothing pending is reported as such", async () => {
	await expect(TagsTokenModule.releasePurchaseRewards()).resolves.toEqual({ nothingToProcess: true });
	expect(RewardTransfer.sendRewardTransfer).not.toHaveBeenCalled();
});

test("pays the oldest pending reward in whole tokens, storing the signature before the broadcast", async () => {
	const newer = addPending({ createdAt: "2026-10-01T09:00:00.000Z" });
	const oldest = addPending({ tokenAmount: 1500, createdAt: "2026-10-01T08:00:00.000Z" });
	RewardTransfer.sendRewardTransfer.mockImplementation(sender("confirmed", "sig-1"));

	const result = await TagsTokenModule.releasePurchaseRewards();

	// 1500 ZNS is sent as 1500 whole tokens: the old "< 1000 means tokens" rule sent 0.000015.
	expect(RewardTransfer.sendRewardTransfer).toHaveBeenCalledTimes(1);
	expect(RewardTransfer.sendRewardTransfer.mock.calls[0].slice(0, 2)).toEqual([1500, RECEIVER]);
	expect(broadcasts[0].storedBeforeBroadcast).toContain("sig-1");
	expect(result).toMatchObject({ _id: oldest._id, status: "completed", attempts: 1, signature: "sig-1" });
	expect(stored(oldest._id)).toMatchObject({ status: "completed", attempts: 1, payload: { signature: "sig-1", transferSignature: "sig-1", tokenAmount: 1500 } });
	expect(stored(newer._id).status).toBe("pending");
});

test("an unconfirmed transfer stays reserved and is never signed again until the chain decides", async () => {
	const record = addPending();
	RewardTransfer.sendRewardTransfer.mockImplementation(sender("pending", "sig-1"));

	await expect(TagsTokenModule.releasePurchaseRewards()).resolves.toMatchObject({ pending: true, signature: "sig-1", attempts: 1 });
	expect(stored(record._id)).toMatchObject({ status: "processing", payload: { transferSignature: "sig-1", lastValidBlockHeight: 1000 } });

	// Still able to land: the next run leaves it alone and signs nothing.
	await expect(TagsTokenModule.releasePurchaseRewards()).resolves.toEqual({ nothingToProcess: true });
	expect(RewardTransfer.getRewardTransferOutcome).toHaveBeenLastCalledWith({ signature: "sig-1", lastValidBlockHeight: 1000 });
	expect(RewardTransfer.sendRewardTransfer).toHaveBeenCalledTimes(1);

	// It landed: settled from the chain, still without a second transfer.
	RewardTransfer.getRewardTransferOutcome.mockResolvedValue({ state: "confirmed" });
	await expect(TagsTokenModule.releasePurchaseRewards()).resolves.toEqual({ nothingToProcess: true });
	expect(stored(record._id)).toMatchObject({ status: "completed", payload: { signature: "sig-1" } });
	expect(RewardTransfer.sendRewardTransfer).toHaveBeenCalledTimes(1);
});

test("an expired transfer is released and the retry signs a new one", async () => {
	const record = addPending();
	RewardTransfer.sendRewardTransfer.mockImplementationOnce(sender("pending", "sig-1")).mockImplementationOnce(sender("confirmed", "sig-2"));

	await TagsTokenModule.releasePurchaseRewards();
	RewardTransfer.getRewardTransferOutcome.mockResolvedValue({ state: "expired" });

	const result = await TagsTokenModule.releasePurchaseRewards();

	expect(RewardTransfer.sendRewardTransfer).toHaveBeenCalledTimes(2);
	expect(broadcasts[1].storedBeforeBroadcast).toEqual(["sig-2"]);
	expect(result).toMatchObject({ status: "completed", signature: "sig-2", attempts: 2 });
	expect(stored(record._id)).toMatchObject({ status: "completed", attempts: 2, payload: { signature: "sig-2", transferSignature: "sig-2" } });
});

test("two concurrent releases never take the same reward", async () => {
	addPending();
	RewardTransfer.sendRewardTransfer.mockImplementation(sender("confirmed", "sig-1"));

	const results = await Promise.all([TagsTokenModule.releasePurchaseRewards(), TagsTokenModule.releasePurchaseRewards()]);

	expect(RewardTransfer.sendRewardTransfer).toHaveBeenCalledTimes(1);
	expect(results).toContainEqual({ nothingToProcess: true });
	expect(results.find((result) => result.status === "completed")).toBeTruthy();
});

test("a transfer that never left the server releases the reward for a retry (503)", async () => {
	const record = addPending();
	RewardTransfer.sendRewardTransfer.mockRejectedValue(new Error("rewards_wallet_insufficient_balance"));

	await expect(TagsTokenModule.releasePurchaseRewards()).rejects.toMatchObject({ status: 503, code: "reward_transfer_not_sent" });
	expect(stored(record._id)).toMatchObject({ status: "pending", attempts: 1, payload: { error: "rewards_wallet_insufficient_balance" } });
	expect(stored(record._id).payload.transferSignature).toBeUndefined();
});

test("a transfer that failed on chain moved nothing and is released for a retry (502)", async () => {
	const record = addPending();
	RewardTransfer.sendRewardTransfer.mockImplementation(sender("failed", "sig-1", { error: '{"InstructionError":[2,{"Custom":1}]}' }));

	await expect(TagsTokenModule.releasePurchaseRewards()).rejects.toMatchObject({ status: 502, code: "reward_transfer_failed" });
	expect(stored(record._id)).toMatchObject({ status: "pending", attempts: 1 });
});

test("nothing is broadcast when the reservation was lost before the signature could be stored", async () => {
	const record = addPending();
	RewardTransfer.sendRewardTransfer.mockImplementation(async (amount, address, { onSigned }) => {
		stored(record._id).status = "completed"; // settled elsewhere meanwhile
		await onSigned({ signature: "sig-1", lastValidBlockHeight: 1000 });
		broadcasts.push("sent");
		return { state: "confirmed", signature: "sig-1" };
	});

	await expect(TagsTokenModule.releasePurchaseRewards()).rejects.toMatchObject({ status: 409, code: "reward_claim_in_progress" });
	expect(broadcasts).toEqual([]);
	expect(stored(record._id).status).toBe("completed");
});

test("a reward that used up its attempts is marked failed for a person, without a transfer", async () => {
	const record = addPending({ attempts: TagsTokenModule.MAX_PURCHASE_REWARD_ATTEMPTS });

	await expect(TagsTokenModule.releasePurchaseRewards()).resolves.toMatchObject({ status: "failed" });
	expect(stored(record._id).status).toBe("failed");
	expect(RewardTransfer.sendRewardTransfer).not.toHaveBeenCalled();
});

test("a denylisted receiver is failed without a transfer", async () => {
	const previous = process.env.ZNS_PAYOUT_DENYLIST;
	process.env.ZNS_PAYOUT_DENYLIST = RECEIVER;

	try {
		const record = addPending();

		await expect(TagsTokenModule.releasePurchaseRewards()).rejects.toMatchObject({
			message: "403:PAYOUT_ADDRESS_BLOCKED",
			status: 403,
			code: "PAYOUT_ADDRESS_BLOCKED",
		});
		expect(RewardTransfer.sendRewardTransfer).not.toHaveBeenCalled();
		expect(stored(record._id)).toMatchObject({ status: "failed", payload: { error: "PAYOUT_ADDRESS_BLOCKED" } });
	} finally {
		if (previous === undefined) delete process.env.ZNS_PAYOUT_DENYLIST;
		else process.env.ZNS_PAYOUT_DENYLIST = previous;
	}
});

test("a reward without a valid token amount is failed, never sent", async () => {
	const record = addPending({ tokenAmount: 0 });

	await expect(TagsTokenModule.releasePurchaseRewards()).resolves.toMatchObject({ status: "failed" });
	expect(stored(record._id)).toMatchObject({ status: "failed", payload: { error: "invalid_reward_amount" } });
	expect(RewardTransfer.sendRewardTransfer).not.toHaveBeenCalled();
});

test("the unsafe sender and the batch referral release are gone", () => {
	expect(TagsTokenModule.giveTokensAfterPurchase).toBeUndefined();
	expect(TagsTokenModule.releaseReferralRewards).toBeUndefined();
});
