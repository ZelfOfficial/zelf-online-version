const store = new Map();

jest.mock("../../Repositories/ZelfID/models/zelf-id-purchase-manual-review.model", () => ({
    findOne: jest.fn(async (query) => {
        const key = query?.paymentKey;
        return key && store.has(key) ? store.get(key) : null;
    }),
    create: jest.fn(async (doc) => {
        if (doc.paymentKey && store.has(doc.paymentKey)) {
            const error = new Error("duplicate");
            error.code = 11000;
            throw error;
        }
        const record = { ...doc, _id: `id-${store.size + 1}` };
        if (doc.paymentKey) store.set(doc.paymentKey, record);
        return record;
    }),
}));

const { resolvePaymentKey, recordPurchaseManualReview } = require("../../Repositories/ZelfID/modules/zelf-id-purchase-manual-review.module");

const domainConfig = {
    tags: { payment: { planPricing: { premium: { "6-15": { 1: 29 } }, unlimited: { "6-15": { 1: 99 } } } } },
};

const tagObject = {
    publicData: {
        tagName: "jimqatest.zelf",
        plan: "unlimited",
        duration: "1",
        expiresAt: "2126-01-01 00:00:00",
    },
};

describe("zelf-id-purchase-manual-review.module", () => {
    beforeEach(() => {
        store.clear();
        jest.clearAllMocks();
    });

    test("resolvePaymentKey prefers Stripe session, then crypto tx, then RevenueCat event", () => {
        expect(resolvePaymentKey({ sessionId: "cs_abc" })).toBe("stripe:session:cs_abc");
        expect(resolvePaymentKey({ txHash: "0xabc", paymentNetwork: "ETH" })).toBe("crypto:ETH:0xabc");
        expect(resolvePaymentKey({ eventID: "evt-1" })).toBe("revenuecat:event:evt-1");
    });

    test("recordPurchaseManualReview is idempotent per paymentKey", async () => {
        const input = {
            tagName: "jimqatest",
            domain: "zelf",
            plan: "premium",
            duration: "1",
            price: 29,
            billableUsdPrice: 29,
            source: "stripe",
            violationCode: "409:PLAN_DOWNGRADE_NOT_ALLOWED",
            sessionId: "cs_test_once",
            tagObject,
            domainConfig,
        };

        const first = await recordPurchaseManualReview(input);
        const second = await recordPurchaseManualReview(input);

        expect(first.created).toBe(true);
        expect(second.created).toBe(false);
        expect(store.size).toBe(1);
        expect(second.record.paymentKey).toBe("stripe:session:cs_test_once");
        expect(first.record.context).toMatchObject({
            tag: "jimqatest.zelf",
            requestedPlan: "premium",
            currentPlan: "unlimited",
            sessionId: "cs_test_once",
            amounts: { usd: { currency: "USD", amount: 29 } },
        });
    });
});
