/**
 * A daily reward is claimed only after the payout is confirmed.
 * A failed payout releases the day. Two concurrent claims can pay only once.
 * A payout whose confirmation was not stored is completed from its signature, not paid again.
 */
jest.mock("../../Repositories/Tags/modules/tags.module", () => ({
    decryptTag: jest.fn(async () => ({})),
}));

jest.mock("../../Repositories/Tags/modules/tags-search.module", () => ({
    searchTag: jest.fn(),
}));

jest.mock("../../Repositories/Tags/config/supported-domains", () => ({
    getDomainConfig: jest.fn(() => ({
        getTagKey: () => "tagName",
        name: "zelf",
    })),
}));

jest.mock("../../Repositories/ZelfProof/modules/zelf-proof.module", () => {
    const actual = jest.requireActual("../../Repositories/ZelfProof/modules/zelf-proof.module");

    return {
        ...actual,
        previewWithLegacyFallback: jest.fn(async () => ({ passwordLayer: "WithoutPassword" })),
    };
});

jest.mock("../../Repositories/ZelfNameService/modules/zns-token.module", () => ({
    isAccountActive: jest.fn(async () => true),
    giveTokensAfterPurchase: jest.fn(),
}));

jest.mock("../../Repositories/Tags/modules/referral-reward-transfer", () => ({
    sendRewardTransfer: jest.fn(),
    getRewardTransferOutcome: jest.fn(),
}));

jest.mock("../../Repositories/ZelfNameService/modules/zns-search.module", () => ({
    searchZelfName: jest.fn(),
}));

jest.mock("../../Repositories/ZelfNameService/modules/zns-transaction-detector.module", () => ({
    hasSentZNSTokens: jest.fn(),
}));

jest.mock("../../Core/ipfs", () => ({
    filter: jest.fn(async () => []),
    pinFile: jest.fn(async () => ({ IpfsHash: "cid-daily" })),
    unPinFiles: jest.fn(async () => {}),
    retrieve: jest.fn(),
}));

jest.mock("../../Repositories/Rewards/models/rewards.model", () => {
    const getPath = (doc, path) => path.split(".").reduce((cursor, key) => (cursor == null ? undefined : cursor[key]), doc);

    const setPath = (doc, path, value) => {
        const keys = path.split(".");
        let cursor = doc;

        for (let index = 0; index < keys.length - 1; index += 1) {
            if (cursor[keys[index]] == null || typeof cursor[keys[index]] !== "object") cursor[keys[index]] = {};
            cursor = cursor[keys[index]];
        }

        cursor[keys[keys.length - 1]] = value;
    };

    const matches = (doc, filter = {}) =>
        Object.entries(filter).every(([key, expected]) => {
            if (key === "$or") return expected.some((branch) => matches(doc, branch));
            if (key === "$and") return expected.every((branch) => matches(doc, branch));

            const actual = getPath(doc, key);

            if (expected && typeof expected === "object" && !Array.isArray(expected) && !(expected instanceof Date)) {
                if ("$in" in expected) return expected.$in.some((item) => item === actual || (item == null && actual == null));
                if ("$exists" in expected) return expected.$exists ? actual != null : actual == null;
                if ("$lte" in expected) return String(actual) <= String(expected.$lte);
            }

            if (expected == null) return actual == null;

            return actual === expected;
        });

    const applyUpdate = (doc, update = {}) => {
        for (const [key, value] of Object.entries(update.$set || {})) setPath(doc, key, value);
        for (const key of Object.keys(update.$unset || {})) setPath(doc, key, undefined);
    };

    function Reward(doc) {
        Object.assign(this, doc);
        this._id = doc._id || `mongo-reward-${Reward.instances.length + 1}`;
        Reward.instances.push(this);
    }

    Reward.instances = [];
    Reward.create = jest.fn(async (doc) => {
        if (Reward.instances.some((item) => item.rewardPrimaryKey === doc.rewardPrimaryKey)) {
            const error = new Error("E11000 duplicate key");
            error.code = 11000;
            throw error;
        }

        return new Reward({ ...doc, payload: { ...(doc.payload || {}) } });
    });
    Reward.findOne = jest.fn(async (query) => Reward.instances.find((item) => matches(item, query)) || null);
    Reward.updateOne = jest.fn(async (filter, update) => {
        const doc = Reward.instances.find((item) => matches(item, filter));

        if (!doc) return { modifiedCount: 0 };

        applyUpdate(doc, update);
        return { modifiedCount: 1 };
    });
    Reward.findOneAndUpdate = jest.fn(async (filter, update) => {
        const doc = Reward.instances.find((item) => matches(item, filter));

        if (!doc) return null;

        applyUpdate(doc, update);
        return doc;
    });
    Reward.deleteOne = jest.fn(async () => ({ deletedCount: 0 }));

    return Reward;
});

const moment = require("moment");
const TagsModule = require("../../Repositories/Tags/modules/tags.module");
const TagsSearchModule = require("../../Repositories/Tags/modules/tags-search.module");
const ZNSTokenModule = require("../../Repositories/ZelfNameService/modules/zns-token.module");
const RewardTransfer = require("../../Repositories/Tags/modules/referral-reward-transfer");
const IPFS = require("../../Core/ipfs");
const Reward = require("../../Repositories/Rewards/models/rewards.model");
const { dailyRewards } = require("../../Repositories/Rewards/modules/rewards.module");
const Controller = require("../../Repositories/Rewards/controllers/rewards.controller");

const authUser = { tagName: "session-other", domain: "avax", identifier: "session-other" };

const tagObject = () => ({
    zelfProof: "proof-bytes",
    publicData: {
        type: "hold",
        solanaAddress: "SoLanaAddress111",
        tagName: "owner.zelf",
        hasPassword: "false",
        domain: "zelf",
    },
});

const claimBody = (extra = {}) => ({
    tagName: "owner",
    domain: "zelf",
    faceBase64: "face-ok",
    ...extra,
});

const ctxFor = (body = claimBody()) => ({
    request: { body },
    state: { user: authUser },
});

const confirmTransfer = (signature) => async (_amount, _address, options) => {
    if (options?.onSigned) await options.onSigned({ signature, lastValidBlockHeight: 20 });

    return { state: "confirmed", signature, lastValidBlockHeight: 20 };
};

beforeEach(() => {
    jest.clearAllMocks();
    Reward.instances.length = 0;
    ZNSTokenModule.isAccountActive.mockResolvedValue(true);
    IPFS.filter.mockResolvedValue([]);
    IPFS.pinFile.mockResolvedValue({ IpfsHash: "cid-daily" });
    TagsModule.decryptTag.mockResolvedValue({});
    TagsSearchModule.searchTag.mockImplementation(async () => ({ tagObject: tagObject() }));
    RewardTransfer.sendRewardTransfer.mockImplementation(confirmTransfer("sig-daily"));
    RewardTransfer.getRewardTransferOutcome.mockResolvedValue({ state: "pending" });
    jest.spyOn(Math, "random").mockReturnValue(0);
    jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe("daily reward claim reliability", () => {
    it("releases the day when the payout fails and pays it on the next attempt", async () => {
        RewardTransfer.sendRewardTransfer.mockImplementationOnce(async (_amount, _address, options) => {
            await options.onSigned({ signature: "sig-failed", lastValidBlockHeight: 3 });

            return { state: "failed", signature: "sig-failed", lastValidBlockHeight: 3, error: "InstructionError" };
        });

        const failed = ctxFor();

        await Controller.dailyRewards(failed);

        expect(failed.status).toBe(502);
        expect(failed.body).toEqual({
            message: "DAILY_REWARD_PAYOUT_FAILED",
            code: "DAILY_REWARD_PAYOUT_FAILED",
        });
        expect(Reward.instances).toHaveLength(1);
        expect(Reward.instances[0].status).toBe("failed");
        expect(Reward.instances[0].payload.transferSignature).toBeUndefined();
        expect(IPFS.pinFile).not.toHaveBeenCalled();

        const retried = ctxFor();

        await Controller.dailyRewards(retried);

        expect(retried.body.success).toBe(true);
        expect(retried.body.reward.amount).toBe(1);
        expect(retried.body.reward.tokenTransfer.signature).toBe("sig-daily");
        expect(RewardTransfer.sendRewardTransfer).toHaveBeenCalledTimes(2);
        expect(Reward.instances).toHaveLength(1);
        expect(Reward.instances[0].status).toBe("claimed");
        expect(Reward.instances[0].payload.payoutConfirmed).toBe(true);
        expect(IPFS.pinFile).toHaveBeenCalledTimes(1);
    });

    it("pays once when two claims for the same day run together", async () => {
        let releaseTransfer;
        const gate = new Promise((resolve) => {
            releaseTransfer = resolve;
        });
        let transfers = 0;

        RewardTransfer.sendRewardTransfer.mockImplementation(async (_amount, _address, options) => {
            transfers += 1;
            await options.onSigned({ signature: "sig-once", lastValidBlockHeight: 8 });
            await gate;

            return { state: "confirmed", signature: "sig-once", lastValidBlockHeight: 8 };
        });

        const attempts = [dailyRewards(claimBody(), authUser), dailyRewards(claimBody(), authUser)];
        const outcomes = [];

        for (const attempt of attempts) {
            attempt.then(
                (value) => outcomes.push({ ok: true, value }),
                (error) => outcomes.push({ ok: false, error })
            );
        }

        for (let attempt = 0; attempt < 40 && !(transfers === 1 && outcomes.length >= 1); attempt += 1) {
            await new Promise((resolve) => setImmediate(resolve));
        }

        expect(transfers).toBe(1);
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0].ok).toBe(false);
        expect(outcomes[0].error).toMatchObject({ status: 503, code: "DAILY_REWARD_CLAIM_IN_PROGRESS" });

        releaseTransfer();
        await Promise.allSettled(attempts);

        expect(transfers).toBe(1);
        expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
        expect(outcomes.find((outcome) => outcome.ok).value.reward.tokenTransfer.signature).toBe("sig-once");
        expect(Reward.instances.filter((item) => item.status === "claimed")).toHaveLength(1);
        expect(ZNSTokenModule.giveTokensAfterPurchase).not.toHaveBeenCalled();
    });

    it("returns DAILY_REWARD_ALREADY_CLAIMED for a day that was already paid", async () => {
        await Reward.create({
            name: "owner.zelf",
            rewardPrimaryKey: `owner.zelf${moment().format("YYYY-MM-DD")}`,
            amount: 4,
            type: "daily",
            status: "claimed",
            zelfNameType: "hold",
            description: "already paid",
            payload: { payoutConfirmed: true, signature: "sig-old", winningIndex: 3, segments: [1] },
        });

        const ctx = ctxFor();

        await Controller.dailyRewards(ctx);

        expect(ctx.status).toBe(409);
        expect(ctx.body.code).toBe("DAILY_REWARD_ALREADY_CLAIMED");
        expect(ctx.body.message).toMatch(/already claimed/i);
        expect(RewardTransfer.sendRewardTransfer).not.toHaveBeenCalled();
        expect(IPFS.pinFile).not.toHaveBeenCalled();
        expect(TagsModule.decryptTag).toHaveBeenCalledTimes(1);
    });

    it("does not pay again when today's receipt is already stored", async () => {
        IPFS.filter.mockResolvedValue([{ ipfs_pin_hash: "cid-existing", metadata: { rewardType: "daily" } }]);

        const ctx = ctxFor();

        await Controller.dailyRewards(ctx);

        expect(ctx.status).toBe(409);
        expect(ctx.body.code).toBe("DAILY_REWARD_ALREADY_CLAIMED");
        expect(RewardTransfer.sendRewardTransfer).not.toHaveBeenCalled();
        expect(Reward.instances).toHaveLength(0);
    });

    it("does not store a claim or pay when face authentication fails", async () => {
        const faceError = new Error("ERR_VERIFICATION_FAILED");
        faceError.status = 422;
        faceError.code = "ERR_VERIFICATION_FAILED";
        TagsModule.decryptTag.mockRejectedValue(faceError);

        const ctx = ctxFor();

        await Controller.dailyRewards(ctx);

        expect(ctx.status).toBe(422);
        expect(ctx.body).toEqual({
            message: "ERR_VERIFICATION_FAILED",
            code: "ERR_VERIFICATION_FAILED",
        });
        expect(Reward.instances).toHaveLength(0);
        expect(RewardTransfer.sendRewardTransfer).not.toHaveBeenCalled();
        expect(Reward.findOne).not.toHaveBeenCalled();
    });

    it("completes a confirmed payout from its stored signature instead of paying again", async () => {
        RewardTransfer.sendRewardTransfer.mockImplementationOnce(async (_amount, _address, options) => {
            await options.onSigned({ signature: "sig-landed", lastValidBlockHeight: 11 });

            return { state: "pending", signature: "sig-landed", lastValidBlockHeight: 11 };
        });

        await expect(dailyRewards(claimBody(), authUser)).rejects.toMatchObject({
            status: 503,
            code: "DAILY_REWARD_CLAIM_IN_PROGRESS",
        });
        expect(Reward.instances[0].status).toBe("processing");
        expect(Reward.instances[0].payload.transferSignature).toBe("sig-landed");
        expect(IPFS.pinFile).not.toHaveBeenCalled();

        RewardTransfer.getRewardTransferOutcome.mockResolvedValue({ state: "confirmed" });

        const result = await dailyRewards(claimBody(), authUser);

        expect(result.success).toBe(true);
        expect(result.reward.tokenTransfer.signature).toBe("sig-landed");
        expect(RewardTransfer.sendRewardTransfer).toHaveBeenCalledTimes(1);
        expect(Reward.instances).toHaveLength(1);
        expect(Reward.instances[0].status).toBe("claimed");
        expect(Reward.instances[0].payload.payoutConfirmed).toBe(true);
    });
});
