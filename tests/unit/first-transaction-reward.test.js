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
    giveTokensAfterPurchase: jest.fn(async () => "sig-first"),
}));

jest.mock("../../Repositories/ZelfNameService/modules/zns-search.module", () => ({
    searchZelfName: jest.fn(),
}));

jest.mock("../../Repositories/ZelfNameService/modules/zns-transaction-detector.module", () => ({
    hasSentZNSTokens: jest.fn(),
}));

jest.mock("../../Core/ipfs", () => ({
    filter: jest.fn(async () => []),
    pinFile: jest.fn(async () => ({ IpfsHash: "cid-first" })),
    unPinFiles: jest.fn(),
    retrieve: jest.fn(),
}));

jest.mock("../../Repositories/Rewards/models/rewards.model", () => {
    function Reward(doc) {
        Object.assign(this, doc);
        this._id = "mongo-reward-id";
        this.save = jest.fn(async () => this);
    }
    Reward.findOne = jest.fn(async () => null);
    Reward.deleteOne = jest.fn(async () => ({ deletedCount: 0 }));
    return Reward;
});

jest.mock("../../Repositories/Session/models/session.model", () => ({
    findById: jest.fn(),
}));

const TagsModule = require("../../Repositories/Tags/modules/tags.module");
const TagsSearchModule = require("../../Repositories/Tags/modules/tags-search.module");
const ZNSTokenModule = require("../../Repositories/ZelfNameService/modules/zns-token.module");
const ZNSTransactionDetector = require("../../Repositories/ZelfNameService/modules/zns-transaction-detector.module");
const IPFS = require("../../Core/ipfs");
const Session = require("../../Repositories/Session/models/session.model");
const { rewardFirstTransaction } = require("../../Repositories/Rewards/modules/rewards.module");

const authUser = { session: "session-1", domain: "zelf" };

const verifiedSession = (verifiedTagName = "owner.zelf") => ({
    status: "active",
    verifiedTagName,
    verifiedUntil: new Date(Date.now() + 60_000),
    domain: "zelf",
});

const tagObject = {
    zelfProof: "proof",
    publicData: {
        type: "hold",
        solanaAddress: "SoLanaAddress111",
        tagName: "owner.zelf",
        hasPassword: "false",
        domain: "zelf",
    },
};

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
    Session.findById.mockImplementation(() => ({ lean: async () => verifiedSession() }));
    TagsSearchModule.searchTag.mockResolvedValue({ tagObject });
    TagsModule.decryptTag.mockResolvedValue({});
    IPFS.filter.mockResolvedValue([]);
    IPFS.pinFile.mockResolvedValue({ IpfsHash: "cid-first" });
    ZNSTransactionDetector.hasSentZNSTokens.mockResolvedValue({
        hasSent: true,
        transactionCount: 1,
        totalAmountSent: 1,
        lastTransaction: { signature: "chain-tx" },
    });
    ZNSTokenModule.giveTokensAfterPurchase.mockResolvedValue("sig-first");
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe("first transaction reward ownership", () => {
    const body = { tagName: "owner", domain: "zelf", faceBase64: "face-ok" };

    test("pays only after the stored verified name matches and an on-chain send exists", async () => {
        const result = await rewardFirstTransaction(body, authUser);

        expect(result.success).toBe(true);
        expect(TagsModule.decryptTag).toHaveBeenCalledWith(
            expect.objectContaining({ tagName: "owner", domain: "zelf", faceBase64: "face-ok" }),
            authUser
        );
        expect(ZNSTransactionDetector.hasSentZNSTokens).toHaveBeenCalledWith("SoLanaAddress111", expect.any(Object));
        expect(ZNSTokenModule.giveTokensAfterPurchase).toHaveBeenCalledWith(expect.any(Number), "SoLanaAddress111");
    });

    test("rejects a client-supplied name that is not the verified tag", async () => {
        await expect(rewardFirstTransaction({ ...body, tagName: "other" }, authUser)).rejects.toMatchObject({
            code: "ERR_SESSION_OWNER_MISMATCH",
            status: 403,
        });
        expect(ZNSTokenModule.giveTokensAfterPurchase).not.toHaveBeenCalled();
        expect(TagsModule.decryptTag).not.toHaveBeenCalled();
    });

    test("rejects a session that has no verified tag", async () => {
        Session.findById.mockImplementation(() => ({ lean: async () => ({ status: "active", verifiedTagName: null }) }));

        await expect(rewardFirstTransaction(body, authUser)).rejects.toMatchObject({
            code: "ERR_IDENTITY_VERIFICATION_REQUIRED",
        });
        expect(ZNSTokenModule.giveTokensAfterPurchase).not.toHaveBeenCalled();
    });

    test("does not pay when the wallet has no on-chain ZNS send", async () => {
        ZNSTransactionDetector.hasSentZNSTokens.mockResolvedValue({ hasSent: false });

        const result = await rewardFirstTransaction(body, authUser);

        expect(result.success).toBe(false);
        expect(result.eligible).toBe(false);
        expect(ZNSTokenModule.giveTokensAfterPurchase).not.toHaveBeenCalled();
    });

    test("stays one-time per name", async () => {
        IPFS.filter.mockResolvedValue([{ publicData: { amount: "12" } }]);

        const result = await rewardFirstTransaction(body, authUser);

        expect(result.alreadyClaimed).toBe(true);
        expect(ZNSTokenModule.giveTokensAfterPurchase).not.toHaveBeenCalled();
    });
});
