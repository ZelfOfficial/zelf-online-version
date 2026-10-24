jest.mock("../../Repositories/Tags/modules/tag-smart-contract-payment.module", () => ({
    throwPaymentConfirmationTagNotFound: jest.fn(),
    verifySmartContractPayment: jest.fn(),
}));

jest.mock("../../Repositories/Tags/modules/my-tags.module", () => ({
    confirmPayUniqueAddress: jest.fn(),
}));

jest.mock("../../Repositories/Tags/config/supported-domains", () => ({
    getDomainConfig: jest.fn(),
}));

jest.mock("../../Repositories/ZelfID/modules/zelf-id.module", () => ({
    searchTag: jest.fn(),
}));

jest.mock("../../Repositories/ZelfID/modules/zelf-id-quote-grant.module", () => ({
    claimQuoteGrant: jest.fn(async () => ({ state: "claimed", grant: { status: "pending" } })),
    completeQuoteGrant: jest.fn(async () => null),
    releaseQuoteGrant: jest.fn(async () => null),
}));

jest.mock("jsonwebtoken", () => ({
    verify: jest.fn(),
}));

const manualReviewStore = new Map();
jest.mock("../../Repositories/ZelfID/modules/zelf-id-purchase-manual-review.module", () => {
    const actual = jest.requireActual("../../Repositories/ZelfID/modules/zelf-id-purchase-manual-review.module");
    return {
        ...actual,
        recordPurchaseManualReview: jest.fn(async (input) => {
            const key = actual.resolvePaymentKey(input);
            if (key && manualReviewStore.has(key)) {
                return { record: manualReviewStore.get(key), created: false };
            }
            const record = { _id: "review-1", paymentKey: key };
            if (key) manualReviewStore.set(key, record);
            return { record, created: true };
        }),
    };
});

const moment = require("moment");
const { verifyPaymentConfirmation } = require("../../Repositories/ZelfID/modules/my-zelf-id.module");
const { claimQuoteGrant } = require("../../Repositories/ZelfID/modules/zelf-id-quote-grant.module");
const { confirmPaidStripeSession, buildLeaseStripeMetadata } = require("../../Repositories/ZelfID/modules/zelf-ids-stripe.module");
const { addDurationToTag } = require("../../Repositories/ZelfID/modules/my-zelf-id.module");
const ZelfIdModule = require("../../Repositories/ZelfID/modules/zelf-id.module");
const { getDomainConfig } = require("../../Repositories/Tags/config/supported-domains");
const { recordPurchaseManualReview } = require("../../Repositories/ZelfID/modules/zelf-id-purchase-manual-review.module");

const domainConfig = {
    name: "zelf",
    getTagKey: () => "tagName",
    tags: {
        minLength: 1,
        maxLength: 27,
        payment: {
            rewardPrice: 10,
            whitelist: {},
            planPricing: {
                premium: { "6-15": { 1: 29, lifetime: 144 } },
                unlimited: { "6-15": { 1: 99, lifetime: 494 } },
            },
        },
    },
    getPrice: (tagName, duration, referralTagName, options = {}) => {
        const plan = options.plan || "premium";
        const base = plan === "unlimited" ? 99 : 29;
        return {
            duration: `${duration}`,
            price: base,
            priceWithoutDiscount: base,
            reward: base / 10,
            discount: 0,
            discountType: "percentage",
        };
    },
    licensePlanDurations: () => ["1", "lifetime"],
};

describe("Zelf ID purchase guards", () => {
    const lifetimeTag = () => ({
        publicData: {
            tagName: "jimqatest.zelf",
            type: "mainnet",
            plan: "premium",
            duration: "lifetime",
            expiresAt: moment().add(100, "year").format("YYYY-MM-DD HH:mm:ss"),
            renewedAt: moment().add(1, "hour").format("YYYY-MM-DD HH:mm:ss"),
            registeredAt: "2020-01-01 00:00:00",
            v: "4",
        },
    });

    beforeEach(() => {
        jest.clearAllMocks();
        manualReviewStore.clear();
        getDomainConfig.mockReturnValue({
            ...domainConfig,
            isIPFSEnabled: () => false,
            isArweaveEnabled: () => false,
        });
    });

    test("FREE payment confirmation replay after lifetime purchase returns cache, not 409", async () => {
        const jwt = require("jsonwebtoken");
        const initiatedAt = moment().subtract(2, "hours").unix();
        jwt.verify.mockReturnValue({
            tagName: "jimqatest.zelf",
            tagPayName: "jimqatest.zelfpay",
            plan: "premium",
            duration: 1,
            initiatedAt,
            referralTagName: "coupon.zelf",
            freeCheckout: true,
        });
        ZelfIdModule.searchTag.mockResolvedValue({
            available: false,
            tagObject: {
                ...lifetimeTag(),
                publicData: {
                    ...lifetimeTag().publicData,
                    tagName: "jimqatest.zelf",
                },
            },
        });

        await expect(verifyPaymentConfirmation("jimqatest", "zelf", "FREE", "signed.jwt")).rejects.toMatchObject({
            clientCode: "ERR_IDENTITY_VERIFICATION_REQUIRED",
        });
    });

    test("confirmPaidStripeSession replay after lifetime purchase returns already_extended", async () => {
        const created = moment().subtract(2, "hours").unix();
        ZelfIdModule.searchTag.mockResolvedValue({
            available: false,
            tagObject: lifetimeTag(),
        });

        const metadata = buildLeaseStripeMetadata({
            tagName: "jimqatest",
            domain: "zelf",
            duration: "1",
            plan: "premium",
            amountUsd: 29,
        });

        claimQuoteGrant.mockResolvedValueOnce({
            state: "done",
            grant: { zelfName: "jimqatest.zelf", source: "stripe", status: "done", paymentMethod: "stripe" },
        });

        const result = await confirmPaidStripeSession({
            metadata,
            payment_status: "paid",
            created,
            amount_total: 2900,
            id: "cs_test_replay",
        });

        expect(result.action).toBe("already_extended");
        expect(result.cache).toBe(true);
        expect(result.confirmed).toBe(true);
    });

    test("confirmPaidStripeSession returns needs_manual_review without throwing when post-payment guard blocks stamp", async () => {
        const created = moment().subtract(1, "hour").unix();
        ZelfIdModule.searchTag.mockResolvedValue({
            available: false,
            tagObject: {
                publicData: {
                    tagName: "jimqatest.zelf",
                    type: "mainnet",
                    plan: "unlimited",
                    duration: "1",
                    expiresAt: moment().add(1, "year").format("YYYY-MM-DD HH:mm:ss"),
                    renewedAt: moment().subtract(2, "hours").format("YYYY-MM-DD HH:mm:ss"),
                    registeredAt: "2020-01-01 00:00:00",
                    v: "4",
                },
            },
        });

        const session = {
            metadata: buildLeaseStripeMetadata({
                tagName: "jimqatest",
                domain: "zelf",
                duration: "1",
                plan: "premium",
                amountUsd: 29,
            }),
            payment_status: "paid",
            created,
            amount_total: 2900,
            id: "cs_test_manual_review",
        };

        const first = await confirmPaidStripeSession(session);
        expect(first.status).toBe("success");
        expect(first.action).toBe("needs_manual_review");
        expect(first.manualReview).toBe(true);
        expect(first.confirmed).toBe(false);
        expect(recordPurchaseManualReview).toHaveBeenCalledTimes(1);

        const second = await confirmPaidStripeSession(session);
        expect(second.action).toBe("needs_manual_review");
        expect(second.cache).toBe(true);
        expect(recordPurchaseManualReview).toHaveBeenCalledTimes(2);
        expect(manualReviewStore.size).toBe(1);
    });

    test("addDurationToTag after captured payment records manual review instead of stamping", async () => {
        const tagObject = {
            publicData: {
                tagName: "jimqatest.zelf",
                type: "mainnet",
                plan: "unlimited",
                duration: "1",
                expiresAt: moment().add(1, "year").format("YYYY-MM-DD HH:mm:ss"),
                v: "4",
            },
        };
        getDomainConfig.mockReturnValue({
            ...domainConfig,
            isIPFSEnabled: () => false,
            isArweaveEnabled: () => false,
        });

        const result = await addDurationToTag(
            {
                tagName: "jimqatest",
                domain: "zelf",
                duration: 1,
                plan: "premium",
                price: 29,
                domainConfig: {
                    ...domainConfig,
                    isIPFSEnabled: () => false,
                    isArweaveEnabled: () => false,
                },
                paymentCaptured: true,
                paymentSource: "stripe",
                sessionId: "cs_test_add_duration",
                billableUsdPrice: 29,
            },
            tagObject
        );

        expect(result.manualReview).toBe(true);
        expect(result.status).toBe("needs_manual_review");
        expect(recordPurchaseManualReview).toHaveBeenCalledWith(
            expect.objectContaining({
                violationCode: "409:plan_downgrade_not_allowed",
                source: "stripe",
            })
        );
    });
});
