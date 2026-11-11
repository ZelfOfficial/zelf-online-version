process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_presale_idempotency";

const mockSessionRetrieve = jest.fn();

jest.mock("stripe", () =>
    jest.fn().mockImplementation(() => ({
        checkout: { sessions: { retrieve: (...args) => mockSessionRetrieve(...args), create: jest.fn() } },
    }))
);

jest.mock("../../Core/mailgun", () => ({
    sendEmail: jest.fn(),
}));

jest.mock("../../Repositories/IPFS/modules/ipfs.module", () => ({
    get: jest.fn(),
    insert: jest.fn(),
    unPinFiles: jest.fn(),
}));

jest.mock("../../Repositories/ZelfNameService/modules/zns-token.module", () => ({
    giveTokensAfterPurchase: jest.fn(),
}));

jest.mock("../../Repositories/Tags/modules/my-tags.module", () => ({
    extendTagDurationFree: jest.fn(),
}));

jest.mock("../../Repositories/PreSale/models/presale-lock.model", () => ({
    create: jest.fn(),
    deleteOne: jest.fn(),
}));

jest.mock("axios", () => {
    const actual = jest.requireActual("axios");
    return { ...actual, get: jest.fn() };
});

const IPFS = require("../../Repositories/IPFS/modules/ipfs.module");
const ZNSTokenModule = require("../../Repositories/ZelfNameService/modules/zns-token.module");
const MyTagsModule = require("../../Repositories/Tags/modules/my-tags.module");
const PresaleLock = require("../../Repositories/PreSale/models/presale-lock.model");
const axios = require("axios");
const { getPaymentDetails, fulfillPaidPresale, fulfillFromVerifiedStripeEvent } = require("../../Repositories/PreSale/modules/pre-sale.module");

const SESSION_ID = "cs_test_presale1234";
const SOLANA = "So11111111111111111111111111111111111111112";

const paidSession = (metadata = {}) => ({
    id: SESSION_ID,
    payment_status: "paid",
    amount_total: 50000,
    currency: "usd",
    customer_email: "buyer@example.com",
    metadata: {
        type: "zns_presale",
        tokens: "1000",
        bonus: "10",
        zelfName: "",
        solanaAddress: SOLANA,
        ...metadata,
    },
});

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
    PresaleLock.create.mockResolvedValue({ sessionId: SESSION_ID });
    PresaleLock.deleteOne.mockResolvedValue({ deletedCount: 1 });
    IPFS.get.mockResolvedValue([]);
    IPFS.insert.mockResolvedValue({ IpfsHash: "cid-receipt" });
    IPFS.unPinFiles.mockResolvedValue([]);
    ZNSTokenModule.giveTokensAfterPurchase.mockResolvedValue("sig-presale");
    MyTagsModule.extendTagDurationFree.mockResolvedValue({ expiresAt: "2028-01-01T00:00:00.000Z" });
    axios.get.mockResolvedValue({ data: {} });
    mockSessionRetrieve.mockResolvedValue(paidSession());
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe("presale session details stay read-only", () => {
    test("a paid checkout does not release tokens or extend a license", async () => {
        mockSessionRetrieve.mockResolvedValue(paidSession({ zelfName: "alice.zelf" }));

        const details = await getPaymentDetails(SESSION_ID);

        expect(details.status).toBe("paid");
        expect(ZNSTokenModule.giveTokensAfterPurchase).not.toHaveBeenCalled();
        expect(MyTagsModule.extendTagDurationFree).not.toHaveBeenCalled();
        expect(PresaleLock.create).not.toHaveBeenCalled();
        expect(IPFS.insert).not.toHaveBeenCalled();
    });
});

describe("presale fulfillment", () => {
    test("pays once and stores the release flag with the payout signature", async () => {
        const result = await fulfillPaidPresale(SESSION_ID);

        expect(ZNSTokenModule.giveTokensAfterPurchase).toHaveBeenCalledTimes(1);
        expect(ZNSTokenModule.giveTokensAfterPurchase).toHaveBeenCalledWith(1000, SOLANA);
        expect(result.metadata.transactionSignature).toBe("sig-presale");
        expect(IPFS.insert).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    tokensReleased: "true",
                    receiptSummary: expect.stringContaining("sig-presale"),
                }),
            }),
            { pro: true }
        );
    });

    test("aborts when the lock cannot be acquired", async () => {
        PresaleLock.create.mockRejectedValue(Object.assign(new Error("duplicate"), { code: 11000 }));

        await expect(fulfillPaidPresale(SESSION_ID)).rejects.toMatchObject({
            code: "PAYMENT_LOCK_UNAVAILABLE",
            status: 409,
        });
        expect(ZNSTokenModule.giveTokensAfterPurchase).not.toHaveBeenCalled();
        expect(MyTagsModule.extendTagDurationFree).not.toHaveBeenCalled();
    });

    test("does not pay again when the receipt already records the payout", async () => {
        IPFS.get.mockResolvedValue([
            {
                ipfs_pin_hash: "cid-old",
                url: "https://ipfs.example/receipt",
                publicData: {
                    tokensReleased: "false",
                    licenseExtended: "false",
                    amountUSD: "500",
                    presaleSolanaAddress: SOLANA,
                    receiptSummary: JSON.stringify({ tx: "sig-already" }),
                },
            },
        ]);
        axios.get.mockResolvedValue({ data: { release: { released: true, signature: "sig-already" } } });

        await expect(fulfillPaidPresale(SESSION_ID)).rejects.toMatchObject({ code: "TOKENS_ALREADY_RELEASED" });
        expect(ZNSTokenModule.giveTokensAfterPurchase).not.toHaveBeenCalled();
    });

    test("does not extend a license that is already recorded", async () => {
        mockSessionRetrieve.mockResolvedValue(paidSession({ zelfName: "alice.zelf" }));
        IPFS.get.mockResolvedValue([
            {
                ipfs_pin_hash: "cid-old",
                publicData: {
                    tokensReleased: "true",
                    licenseExtended: "true",
                    presaleZelfName: "alice.zelf",
                    presaleSolanaAddress: SOLANA,
                    receiptSummary: JSON.stringify({ tx: "sig-already", ly: 2 }),
                },
            },
        ]);

        await expect(fulfillPaidPresale(SESSION_ID)).rejects.toMatchObject({ code: "LICENSE_ALREADY_EXTENDED" });
        expect(MyTagsModule.extendTagDurationFree).not.toHaveBeenCalled();
        expect(ZNSTokenModule.giveTokensAfterPurchase).not.toHaveBeenCalled();
    });

    test("a repeated verified webhook reports the receipt as already fulfilled", async () => {
        IPFS.get.mockResolvedValue([
            {
                publicData: {
                    tokensReleased: "true",
                    licenseExtended: "false",
                    receiptSummary: JSON.stringify({ tx: "sig-already" }),
                },
            },
        ]);

        const result = await fulfillFromVerifiedStripeEvent({
            type: "checkout.session.completed",
            data: { object: paidSession() },
        });

        expect(result).toMatchObject({
            status: "success",
            action: "presale_already_fulfilled",
            code: "TOKENS_ALREADY_RELEASED",
        });
        expect(ZNSTokenModule.giveTokensAfterPurchase).not.toHaveBeenCalled();
    });
});
