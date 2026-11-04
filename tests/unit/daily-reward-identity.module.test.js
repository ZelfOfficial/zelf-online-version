/**
 * Daily reward claims must prove control of the rewarded Zelf ID before any claim is stored
 * or any ZNS transfer runs. Ownership decrypt is mocked; wheel amounts and the transfer call stay real.
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
    giveTokensAfterPurchase: jest.fn(async () => "sig-daily"),
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
    function Reward(doc) {
        Object.assign(this, doc);
        this._id = "mongo-reward-id";
        this.save = jest.fn(async () => this);
        Reward.instances.push(this);
    }

    Reward.instances = [];
    Reward.findOne = jest.fn(async () => null);
    Reward.deleteOne = jest.fn(async () => ({ deletedCount: 0 }));

    return Reward;
});

const TagsModule = require("../../Repositories/Tags/modules/tags.module");
const TagsSearchModule = require("../../Repositories/Tags/modules/tags-search.module");
const ZelfProofModule = require("../../Repositories/ZelfProof/modules/zelf-proof.module");
const ZNSTokenModule = require("../../Repositories/ZelfNameService/modules/zns-token.module");
const IPFS = require("../../Core/ipfs");
const Reward = require("../../Repositories/Rewards/models/rewards.model");
const { dailyRewards } = require("../../Repositories/Rewards/modules/rewards.module");
const Controller = require("../../Repositories/Rewards/controllers/rewards.controller");

const HOLD_SEGMENTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const MAINNET_SEGMENTS = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24];

const authUser = { tagName: "session-other", domain: "avax", identifier: "session-other" };

const tagObject = (overrides = {}) => ({
    zelfProof: "proof-bytes",
    publicData: {
        type: "hold",
        solanaAddress: "SoLanaAddress111",
        tagName: "owner.zelf",
        hasPassword: "false",
        domain: "zelf",
        ...overrides.publicData,
    },
    ...overrides,
    publicData: {
        type: "hold",
        solanaAddress: "SoLanaAddress111",
        tagName: "owner.zelf",
        hasPassword: "false",
        domain: "zelf",
        ...overrides.publicData,
    },
});

const claimBody = (extra = {}) => ({
    tagName: "owner",
    domain: "zelf",
    faceBase64: "face-ok",
    ...extra,
});

beforeEach(() => {
    jest.clearAllMocks();
    Reward.instances.length = 0;
    Reward.findOne.mockResolvedValue(null);
    ZNSTokenModule.isAccountActive.mockResolvedValue(true);
    ZNSTokenModule.giveTokensAfterPurchase.mockResolvedValue("sig-daily");
    IPFS.filter.mockResolvedValue([]);
    IPFS.pinFile.mockResolvedValue({ IpfsHash: "cid-daily" });
    TagsModule.decryptTag.mockResolvedValue({});
    ZelfProofModule.previewWithLegacyFallback.mockResolvedValue({ passwordLayer: "WithoutPassword" });
    TagsSearchModule.searchTag.mockImplementation(async () => ({ tagObject: tagObject() }));
    jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe("POST /api/rewards/daily identity", () => {
    it("claims a face-only Zelf ID with a valid face and keeps the hold wheel amount", async () => {
        jest.spyOn(Math, "random").mockReturnValue(0);

        const result = await dailyRewards(claimBody(), authUser);

        expect(TagsModule.decryptTag).toHaveBeenCalledTimes(1);
        expect(TagsModule.decryptTag).toHaveBeenCalledWith(
            expect.objectContaining({
                tagName: "owner",
                domain: "zelf",
                faceBase64: "face-ok",
                password: undefined,
            }),
            authUser
        );
        expect(result.success).toBe(true);
        expect(result.reward.amount).toBe(1);
        expect(result.reward.winningIndex).toBe(0);
        expect(result.reward.segments).toEqual(HOLD_SEGMENTS);
        expect(ZNSTokenModule.giveTokensAfterPurchase).toHaveBeenCalledWith(1, "SoLanaAddress111");
        expect(IPFS.pinFile).toHaveBeenCalledWith(
            expect.any(String),
            expect.any(String),
            "application/json",
            expect.objectContaining({ amount: "1", rewardType: "daily" })
        );
        expect(Reward.instances).toHaveLength(1);
        expect(Reward.instances[0].amount).toBe(1);
        expect(JSON.stringify(result)).not.toMatch(/face-ok|mnemonic|secretKey/i);
    });

    it("accepts the face-only placeholder as no password", async () => {
        jest.spyOn(Math, "random").mockReturnValue(0);

        const result = await dailyRewards(claimBody({ masterPassword: "NO_PASSWORD_PLACEHOLDER" }), authUser);

        expect(result.success).toBe(true);
        expect(TagsModule.decryptTag).toHaveBeenCalledWith(
            expect.objectContaining({ password: undefined, tagName: "owner", domain: "zelf" }),
            authUser
        );
    });

    it("still claims a face-only proof when publicData.hasPassword is stale true", async () => {
        jest.spyOn(Math, "random").mockReturnValue(0);
        TagsSearchModule.searchTag.mockResolvedValue({
            tagObject: tagObject({ publicData: { hasPassword: "true" } }),
        });
        ZelfProofModule.previewWithLegacyFallback.mockResolvedValue({ passwordLayer: "WithoutPassword" });

        const result = await dailyRewards(claimBody(), authUser);

        expect(result.success).toBe(true);
        expect(result.reward.amount).toBe(1);
        expect(TagsModule.decryptTag).toHaveBeenCalledWith(expect.objectContaining({ password: undefined }), authUser);
    });

    it("uses the mainnet wheel (even amounts) after a valid face", async () => {
        jest.spyOn(Math, "random").mockReturnValue(0);
        TagsSearchModule.searchTag.mockResolvedValue({
            tagObject: tagObject({ publicData: { type: "mainnet" } }),
        });

        const result = await dailyRewards(claimBody(), authUser);

        expect(result.reward.amount).toBe(2);
        expect(result.reward.segments).toEqual(MAINNET_SEGMENTS);
        expect(ZNSTokenModule.giveTokensAfterPurchase).toHaveBeenCalledWith(2, "SoLanaAddress111");
    });

    it("requires masterPassword when the proof has a password layer", async () => {
        ZelfProofModule.previewWithLegacyFallback.mockResolvedValue({ passwordLayer: "WithPassword" });
        TagsSearchModule.searchTag.mockResolvedValue({
            tagObject: tagObject({ publicData: { hasPassword: "true" } }),
        });

        await expect(dailyRewards(claimBody(), authUser)).rejects.toThrow("400:ERR_MISSING_PASSWORD");

        expect(TagsModule.decryptTag).not.toHaveBeenCalled();
        expect(ZNSTokenModule.giveTokensAfterPurchase).not.toHaveBeenCalled();
        expect(IPFS.pinFile).not.toHaveBeenCalled();
        expect(Reward.instances).toHaveLength(0);
        expect(Reward.findOne).not.toHaveBeenCalled();
    });

    it("requires a password when preview is down and the stored flag says the Zelf ID has one", async () => {
        ZelfProofModule.previewWithLegacyFallback.mockRejectedValue(new Error("preview unavailable"));
        TagsSearchModule.searchTag.mockResolvedValue({
            tagObject: tagObject({ publicData: { hasPassword: "true" } }),
        });

        await expect(dailyRewards(claimBody({ masterPassword: "   " }), authUser)).rejects.toThrow("400:ERR_MISSING_PASSWORD");
        expect(TagsModule.decryptTag).not.toHaveBeenCalled();
        expect(Reward.instances).toHaveLength(0);
    });

    it("claims a face+password Zelf ID when both face and masterPassword are valid", async () => {
        jest.spyOn(Math, "random").mockReturnValue(0);
        ZelfProofModule.previewWithLegacyFallback.mockResolvedValue({ passwordLayer: "WithPassword" });
        TagsSearchModule.searchTag.mockResolvedValue({
            tagObject: tagObject({ publicData: { hasPassword: "true" } }),
        });

        const result = await dailyRewards(claimBody({ masterPassword: "vault-secret" }), authUser);

        expect(result.success).toBe(true);
        expect(result.reward.amount).toBe(1);
        expect(TagsModule.decryptTag).toHaveBeenCalledWith(
            expect.objectContaining({
                tagName: "owner",
                domain: "zelf",
                faceBase64: "face-ok",
                password: "vault-secret",
            }),
            authUser
        );
        expect(ZNSTokenModule.giveTokensAfterPurchase).toHaveBeenCalledWith(1, "SoLanaAddress111");
    });

    it("accepts password as the Zelf ID secret when masterPassword is omitted", async () => {
        jest.spyOn(Math, "random").mockReturnValue(0);
        ZelfProofModule.previewWithLegacyFallback.mockResolvedValue({ passwordLayer: "Password" });

        await dailyRewards(claimBody({ password: "vault-secret" }), authUser);

        expect(TagsModule.decryptTag).toHaveBeenCalledWith(expect.objectContaining({ password: "vault-secret" }), authUser);
    });

    it("does not claim or transfer when the face does not match", async () => {
        const faceError = new Error("ERR_VERIFICATION_FAILED");
        faceError.status = 422;
        faceError.code = "ERR_VERIFICATION_FAILED";
        TagsModule.decryptTag.mockRejectedValue(faceError);

        const ctx = {
            request: { body: claimBody({ faceBase64: "wrong-face" }) },
            state: { user: authUser },
        };

        await Controller.dailyRewards(ctx);

        expect(ctx.status).toBe(422);
        expect(ctx.body).toEqual({
            message: "ERR_VERIFICATION_FAILED",
            code: "ERR_VERIFICATION_FAILED",
        });
        expect(ZNSTokenModule.giveTokensAfterPurchase).not.toHaveBeenCalled();
        expect(IPFS.pinFile).not.toHaveBeenCalled();
        expect(Reward.instances).toHaveLength(0);
        expect(Reward.findOne).not.toHaveBeenCalled();
    });

    it("does not claim when the master password does not match", async () => {
        ZelfProofModule.previewWithLegacyFallback.mockResolvedValue({ passwordLayer: "WithPassword" });
        const passwordError = new Error("invalid password");
        TagsModule.decryptTag.mockRejectedValue(passwordError);

        const ctx = {
            request: { body: claimBody({ masterPassword: "wrong-secret" }) },
            state: { user: authUser },
        };

        await Controller.dailyRewards(ctx);

        expect(ctx.status).toBe(401);
        expect(ctx.body.code).toBe("ERR_INVALID_PASSWORD");
        expect(ZNSTokenModule.giveTokensAfterPurchase).not.toHaveBeenCalled();
        expect(Reward.instances).toHaveLength(0);
    });

    it("blocks a second claim for the same day after a valid face", async () => {
        Reward.findOne.mockResolvedValue({
            status: "claimed",
            amount: 4,
            toObject() {
                return { status: "claimed", amount: 4 };
            },
        });

        const result = await dailyRewards(claimBody(), authUser);

        expect(TagsModule.decryptTag).toHaveBeenCalledTimes(1);
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/already claimed/i);
        expect(ZNSTokenModule.giveTokensAfterPurchase).not.toHaveBeenCalled();
        expect(IPFS.pinFile).not.toHaveBeenCalled();
        expect(Reward.instances).toHaveLength(0);
    });

    it("returns ERR_MISSING_PASSWORD from the controller without storing a claim", async () => {
        ZelfProofModule.previewWithLegacyFallback.mockResolvedValue({ passwordLayer: "WithPassword" });

        const ctx = {
            request: { body: claimBody() },
            state: { user: authUser },
        };

        await Controller.dailyRewards(ctx);

        expect(ctx.status).toBe(400);
        expect(ctx.body).toEqual({
            message: "ERR_MISSING_PASSWORD",
            code: "ERR_MISSING_PASSWORD",
        });
        expect(Reward.instances).toHaveLength(0);
        expect(ZNSTokenModule.giveTokensAfterPurchase).not.toHaveBeenCalled();
    });
});
