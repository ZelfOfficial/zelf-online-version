const { Domain } = require("../../Repositories/Tags/modules/domain.class");

const P = { 1: 29, lifetime: 144.99 };
const U = { 1: 99, lifetime: 494.99 };

let domainConfig;

jest.mock("../../Repositories/Tags/config/supported-domains", () => ({
    getDomainConfig: () => domainConfig,
}));

jest.mock("../../Repositories/ZelfID/modules/zelf-id.module", () => ({
    searchTag: jest.fn(),
    _validateReferral: jest.fn(),
}));

jest.mock("../../Repositories/Tags/modules/tags-payment.module", () => ({
    calculateCryptoValue: jest.fn(async () => ({ amountToSend: 1, tokenPriceString: "1" })),
    roundBillableUsdPrice: (n) => n,
}));

jest.mock("../../Repositories/Tags/modules/tags-parts.module", () => ({
    urlToBase64First: jest.fn(),
}));

const mockTagPay = {
    publicData: {
        ethAddress: "0xeth",
        btcAddress: "btc",
        solanaAddress: "sol",
        count: "1",
        registeredAt: "2026-01-01 00:00:00",
        expiresAt: "2126-01-01 00:00:00",
    },
};

jest.mock("../../Repositories/Tags/modules/tags-search.module", () => ({
    searchTag: jest.fn(async () => ({
        tagObject: {
            id: "tagpay-1",
            publicData: mockTagPay.publicData,
        },
    })),
}));

const { getPaymentOptions } = require("../../Repositories/ZelfID/modules/zelf-ids-payment.module");
const ZelfIdModule = require("../../Repositories/ZelfID/modules/zelf-id.module");

describe("Zelf ID checkout quote fields", () => {
    beforeAll(() => {
        domainConfig = new Domain({
            name: "zelf",
            tags: {
                minLength: 1,
                maxLength: 27,
                payment: {
                    rewardPrice: 10,
                    whitelist: { "coupon.zelf": "100%" },
                    pricingTable: {},
                    planPricing: { premium: { "6-15": P }, unlimited: { "6-15": U } },
                },
                storage: { keyPrefix: "tagName", ipfsEnabled: true, arweaveEnabled: false },
            },
        });
    });

    beforeEach(() => {
        jest.clearAllMocks();
        ZelfIdModule.searchTag.mockResolvedValue({
            available: false,
            tagName: "checkoutqa",
            tagObject: {
                publicData: {
                    tagName: "checkoutqa.zelf",
                    type: "mainnet",
                    plan: "free",
                    duration: "1",
                    v: "4",
                    expiresAt: "2126-01-01 00:00:00",
                },
            },
            ipfs: [{ id: "ipfs-1" }],
        });
        ZelfIdModule._validateReferral.mockResolvedValue({
            publicData: { solanaAddress: "ref-sol" },
        });
    });

    test("listPriceUsd is pre-discount while billableUsdPrice follows the license coupon", async () => {
        const quote = await getPaymentOptions("checkoutqa", "zelf", "1", {}, {
            requestedPlan: "unlimited",
            referralTagName: "coupon",
        });

        expect(quote.listPriceUsd).toBe(99);
        expect(quote.billableUsdPrice).toBe(0);
        expect(quote.freeCheckout).toBe(true);
        expect(quote.reward).toBe(9.9);
    });
});
