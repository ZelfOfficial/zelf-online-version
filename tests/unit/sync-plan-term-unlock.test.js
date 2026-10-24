/**
 * Owner unlock must not rewrite the Mongo plan term. A referral re-pin used to
 * save the term without duration and my-plan then reported the lease duration.
 */
jest.mock("../../Repositories/Wallet/modules/stellar", () => ({
    createStellarWallet: () => ({ address: "GMOCK", secretKey: "mock" }),
    healPublicDataXlm: (publicData) => ({
        stellar: { address: publicData.xlmAddress || "GMOCK", secretKey: "mock" },
        shouldPersistXlm: false,
        hadXlmBeforeHeal: Boolean(publicData.xlmAddress),
    }),
}));

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

jest.mock("../../Repositories/Tags/modules/tags-ipfs.module", () => ({
    hydrateContinuationAddresses: jest.fn(async (publicData) => publicData),
    listContinuationSiblingPinIds: jest.fn(async () => []),
    unpinContinuationSiblings: jest.fn(async () => null),
    unPinFiles: jest.fn(async () => null),
    insertSearchablePins: jest.fn(async () => ({ id: "ipfs-1" })),
    upsertSearchablePins: jest.fn(async () => ({ id: "ipfs-1" })),
}));

jest.mock("../../Repositories/Tags/modules/tags-arweave.module", () => ({
    tagRegistration: jest.fn(async () => ({ id: "arw-1" })),
}));

jest.mock("../../Repositories/Tags/config/supported-domains", () => ({
    getDomainConfig: () => ({
        name: "zelf",
        getTagKey: () => "tagName",
        isArweaveEnabled: () => false,
    }),
}));

const { updateTags } = require("../../Repositories/Tags/modules/sync-tag-records.module");
const { savePlanTerm } = require("../../Repositories/ZelfID/modules/zelf-id-plan-term.module");
const PlanTerm = require("../../Repositories/ZelfID/models/zelf-id-plan-term.model");

const tagObject = () => ({
    id: "pin-1",
    zelfProofQRCode: "data:image/png;base64,qr",
    publicData: {
        tagName: "referraln.zelf",
        domain: "zelf",
        type: "mainnet",
        plan: "premium",
        duration: "100",
        hasPassword: "true",
        origin: "online",
        v: 4,
        registeredAt: "2020-01-01 00:00:00",
        expiresAt: "2126-01-01 00:00:00",
        planExpiresAt: "2027-06-01 00:00:00",
        paymentMethod: "whitelist",
        price: 0,
        referralTagName: "ref.zelf",
        referralSolanaAddress: "SoLref111111111111111111111111111111111111",
    },
});

describe("unlock leaves the plan term alone", () => {
    let memory;

    beforeAll(async () => {
        memory = await MongoMemoryServer.create();
        await mongoose.connect(memory.getUri());
    }, 180000);

    afterAll(async () => {
        await mongoose.disconnect();
        if (memory) await memory.stop();
    });

    beforeEach(async () => {
        await PlanTerm.deleteMany({});
    });

    test("a referral name unlocked twice keeps the plan term duration", async () => {
        await savePlanTerm({
            zelfName: "referraln.zelf",
            plan: "premium",
            planExpiresAt: "2027-06-01 00:00:00",
            paymentMethod: "whitelist",
            duration: "1",
        });

        const record = tagObject();
        await updateTags(record, [{ name: "note", value: "x" }], { forceRepin: true });
        await updateTags(record, [{ name: "note", value: "x" }], { forceRepin: true });

        const stored = await PlanTerm.findOne({ zelfName: "referraln.zelf" }).lean();
        expect(stored.duration).toBe("1");
        expect(stored.planExpiresAt).toBe("2027-06-01 00:00:00");
        expect(stored.paymentMethod).toBe("whitelist");
        expect(stored.plan).toBe("premium");
    });

    test("saving a plan field does not clear duration", async () => {
        await savePlanTerm({
            zelfName: "referraln.zelf",
            plan: "premium",
            planExpiresAt: "2027-06-01 00:00:00",
            paymentMethod: "whitelist",
            duration: "1",
        });
        await savePlanTerm({ zelfName: "referraln.zelf", paymentMethod: "whitelist" });

        const stored = await PlanTerm.findOne({ zelfName: "referraln.zelf" }).lean();
        expect(stored.duration).toBe("1");
        expect(stored.planExpiresAt).toBe("2027-06-01 00:00:00");
    });
});
