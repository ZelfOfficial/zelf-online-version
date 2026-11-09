jest.mock("../../Repositories/Wallet/modules/stellar", () => ({
    createStellarWallet: jest.fn(),
    healPublicDataXlm: jest.fn(),
}));

jest.mock("../../Repositories/Tags/modules/tags-search.module", () => ({
    searchTag: jest.fn(),
    searchIPFS: jest.fn(),
    searchArweave: jest.fn(),
}));

jest.mock("../../Repositories/Tags/modules/tags-ipfs.module", () => ({
    unPinFiles: jest.fn(),
    unpinContinuationSiblings: jest.fn(),
}));

jest.mock("../../Repositories/Tags/models/referral-rewards.model", () => ({
    find: jest.fn(async () => []),
}));

const TagsSearchModule = require("../../Repositories/Tags/modules/tags-search.module");
const { _validateReferral, getReferralAvailability } = require("../../Repositories/ZelfID/modules/zelf-id.module");
const { errorHandler } = require("../../Core/http-handler");
const {
    assertReferralAvailabilityRateLimit,
    _resetReferralAvailabilityRateLimit,
} = require("../../Repositories/ZelfID/modules/referral-availability-rate-limit.module");

const domainConfig = {
    name: "zelf",
    getTagKey: () => "tagName",
    tags: { storage: { ipfsEnabled: true, arweaveEnabled: true } },
};

const PRIVATE_REFERRER = {
    available: false,
    tagObject: {
        publicData: {
            type: "mainnet",
            tagName: "alice.zelf",
            solanaAddress: "SECRET_SOL",
            ethAddress: "0xSECRET",
            email: "alice@example.com",
            plan: "unlimited",
        },
    },
};

const friends = (n) =>
    Array.from({ length: n }, (_, i) => ({
        publicData: {
            tagName: `f${i}.zelf.hold`,
            type: "hold",
            referralTagName: "alice.zelf",
            registeredAt: `2026-03-${String(i + 1).padStart(2, "0")} 00:00:00`,
        },
    }));

describe("referral availability (#647)", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        TagsSearchModule.searchIPFS.mockResolvedValue([]);
        TagsSearchModule.searchArweave.mockResolvedValue([]);
        _resetReferralAvailabilityRateLimit();
        delete process.env.REFERRAL_AVAILABILITY_RATE_LIMIT_PER_MINUTE;
    });

    test("unknown inviter is not a referral and accepts nobody", async () => {
        TagsSearchModule.searchTag.mockResolvedValue({ available: true });

        await expect(_validateReferral("missing", {}, domainConfig, { enforceLimit: true })).resolves.toBeNull();

        const summary = await getReferralAvailability("missing", domainConfig);

        expect(summary).toEqual({
            exists: false,
            limit: 10,
            spotsRemaining: 0,
            acceptsNewReferrals: false,
        });
        expect(TagsSearchModule.searchIPFS).not.toHaveBeenCalled();
    });

    test("under the limit a new referral is accepted and the summary has no private fields", async () => {
        TagsSearchModule.searchTag.mockResolvedValue(PRIVATE_REFERRER);
        TagsSearchModule.searchIPFS.mockResolvedValue(friends(3));

        const referrer = await _validateReferral("alice", {}, domainConfig, { enforceLimit: true });
        expect(referrer.publicData.tagName).toBe("alice.zelf");

        const summary = await getReferralAvailability("alice", domainConfig);

        expect(summary).toEqual({
            exists: true,
            limit: 10,
            spotsRemaining: 7,
            acceptsNewReferrals: true,
        });
        expect(Object.keys(summary).sort()).toEqual(["acceptsNewReferrals", "exists", "limit", "spotsRemaining"]);
        const encoded = JSON.stringify(summary);
        expect(encoded).not.toContain("SECRET_SOL");
        expect(encoded).not.toContain("alice@example.com");
        expect(encoded).not.toContain("unlimited");
        expect(encoded).not.toContain("f0.zelf");
    });

    test("at the limit a new registration is rejected and the public check says so", async () => {
        TagsSearchModule.searchTag.mockResolvedValue(PRIVATE_REFERRER);
        TagsSearchModule.searchIPFS.mockResolvedValue(friends(10));

        const summary = await getReferralAvailability("alice.zelf", domainConfig);
        expect(summary).toEqual({
            exists: true,
            limit: 10,
            spotsRemaining: 0,
            acceptsNewReferrals: false,
        });

        await expect(_validateReferral("alice", {}, domainConfig, { enforceLimit: true })).rejects.toMatchObject({
            message: "409:REFERRAL_LIMIT_REACHED",
            clientCode: "REFERRAL_LIMIT_REACHED",
        });

        let caught;
        try {
            await _validateReferral("alice", {}, domainConfig, { enforceLimit: true });
        } catch (error) {
            caught = error;
        }
        expect(errorHandler(caught)).toMatchObject({
            status: 409,
            code: "REFERRAL_LIMIT_REACHED",
            message: "REFERRAL_LIMIT_REACHED",
        });
    });

    test("recovery does not enforce the cap when the inviter is already full", async () => {
        TagsSearchModule.searchTag.mockResolvedValue(PRIVATE_REFERRER);
        TagsSearchModule.searchIPFS.mockResolvedValue(friends(10));

        const referrer = await _validateReferral("alice", {}, domainConfig);
        expect(referrer.publicData.tagName).toBe("alice.zelf");
        expect(referrer.publicData.solanaAddress).toBe("SECRET_SOL");
    });

    test("public lookup is rate limited per IP", () => {
        process.env.REFERRAL_AVAILABILITY_RATE_LIMIT_PER_MINUTE = "2";

        expect(() => assertReferralAvailabilityRateLimit("203.0.113.8")).not.toThrow();
        expect(() => assertReferralAvailabilityRateLimit("203.0.113.8")).not.toThrow();

        let caught;
        try {
            assertReferralAvailabilityRateLimit("203.0.113.8");
        } catch (error) {
            caught = error;
        }

        expect(caught.retryAfterSeconds).toBeGreaterThan(0);
        expect(errorHandler(caught)).toMatchObject({
            status: 429,
            code: "REFERRAL_LOOKUP_RATE_LIMITED",
            message: "REFERRAL_LOOKUP_RATE_LIMITED",
        });
        expect(() => assertReferralAvailabilityRateLimit("203.0.113.9")).not.toThrow();
    });
});
