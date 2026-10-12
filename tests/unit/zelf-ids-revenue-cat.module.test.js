jest.mock("../../Repositories/Tags/config/supported-domains", () => ({
    getDomainConfig: jest.fn(() => ({ getTagKey: () => "tagName" })),
}));

jest.mock("../../Repositories/ZelfID/modules/zelf-id.module", () => ({
    searchTag: jest.fn(),
}));

jest.mock("../../Repositories/ZelfID/modules/my-zelf-id.module", () => ({
    addDurationToTag: jest.fn(),
    revertZelfIdToFreePlan: jest.fn(),
}));

jest.mock("../../Repositories/Tags/modules/tag-smart-contract-payment.module", () => ({
    throwPaymentConfirmationTagNotFound: jest.fn(() => {
        throw new Error("404:tag_not_found");
    }),
}));

const ZelfIdModule = require("../../Repositories/ZelfID/modules/zelf-id.module");
const { addDurationToTag, revertZelfIdToFreePlan } = require("../../Repositories/ZelfID/modules/my-zelf-id.module");
const { parseSubscriptionProductId, defaultZelfIdPlanPricingTables } = require("../../Repositories/ZelfID/modules/zelf-ids-revenue-cat-products.module");
const {
    parseLegacyZelfIdProductId,
    productCoversNameLength,
    resolveNameFromAttributes,
    inspectRevenueCatEvent,
    alreadyAppliedToRecord,
    webhookHandler,
} = require("../../Repositories/ZelfID/modules/zelf-ids-revenue-cat.module");

const OWNER = "0xAbC0000000000000000000000000000000000001";
const PURCHASED_AT_MS = Date.parse("2026-09-29T21:01:00Z");

const rcEvent = (overrides = {}, attributes = {}) => ({
    type: "INITIAL_PURCHASE",
    id: "evt_1",
    app_id: "app_1",
    product_id: "zelf_premium_1y",
    period_type: "NORMAL",
    transaction_id: "2000000000000001",
    original_transaction_id: "orig_txn_1",
    environment: "PRODUCTION",
    currency: "USD",
    price: 29,
    purchased_at_ms: PURCHASED_AT_MS,
    subscriber_attributes: {
        zelfName: { value: "alicebob.zelf", updated_at_ms: PURCHASED_AT_MS },
        ethAddress: { value: OWNER, updated_at_ms: PURCHASED_AT_MS },
        plan: { value: "premium", updated_at_ms: PURCHASED_AT_MS },
        duration: { value: "1", updated_at_ms: PURCHASED_AT_MS },
        ...Object.fromEntries(Object.entries(attributes).map(([k, v]) => [k, { value: v, updated_at_ms: PURCHASED_AT_MS }])),
    },
    ...overrides,
});

describe("parseSubscriptionProductId", () => {
    test("maps v4 subscription and one-time product ids", () => {
        expect(parseSubscriptionProductId("zelf_premium_1y")).toEqual({ plan: "premium", duration: "1", subscription: true });
        expect(parseSubscriptionProductId("zelf_unlimited_3y")).toEqual({ plan: "unlimited", duration: "3", subscription: false });
        expect(parseSubscriptionProductId("zelf_premium_lifetime")).toEqual({ plan: "premium", duration: "lifetime", subscription: false });
        expect(parseSubscriptionProductId("zelf_premium_1y:zelf-premium-1y")).toEqual({ plan: "premium", duration: "1", subscription: true });
    });

    test("default plan pricing matches Andrés USD table", () => {
        const tables = defaultZelfIdPlanPricingTables();
        expect(tables.premium["6-15"]).toEqual({ 1: 29, 2: 43.49, 3: 56.99, lifetime: 144.99 });
        expect(tables.unlimited["1-5"][1]).toBe(99);
        expect(tables.unlimited["6-15"].lifetime).toBe(494.99);
    });
});

describe("parseLegacyZelfIdProductId", () => {
    test("still reads legacy char-bucket store ids", () => {
        expect(parseLegacyZelfIdProductId("zns_char_6_to_15_years_3")).toEqual({
            minLength: 6,
            maxLength: 15,
            duration: "3",
            legacy: true,
        });
    });
});

describe("productCoversNameLength", () => {
    test("legacy bucket covers name length", () => {
        const sixToFifteen = parseLegacyZelfIdProductId("zns_char_6_to_15_years_1");
        expect(productCoversNameLength(sixToFifteen, 8)).toBe(true);
        expect(productCoversNameLength(sixToFifteen, 5)).toBe(false);
    });
});

describe("resolveNameFromAttributes", () => {
    test("splits zelfName and strips a reservation suffix", () => {
        expect(resolveNameFromAttributes({ zelfName: "ABC.zelf.hold" })).toEqual({ tagName: "abc", domain: "zelf" });
    });
});

describe("inspectRevenueCatEvent", () => {
    test("subscription purchase uses product plan and one-year term", () => {
        const inspected = inspectRevenueCatEvent(rcEvent());
        expect(inspected).toMatchObject({
            ok: true,
            action: "purchase",
            plan: "premium",
            duration: "1",
            subscription: true,
            originalTransactionId: "orig_txn_1",
        });
    });

    test("short names cannot take premium", () => {
        const inspected = inspectRevenueCatEvent(
            rcEvent({ product_id: "zelf_premium_1y" }, { zelfName: "abc.zelf", plan: "premium" })
        );
        expect(inspected).toMatchObject({ ok: true, plan: "unlimited" });
    });

    test("RENEWAL is a purchase event", () => {
        const inspected = inspectRevenueCatEvent(rcEvent({ type: "RENEWAL" }));
        expect(inspected.ok).toBe(true);
        expect(inspected.action).toBe("purchase");
    });

    test("EXPIRATION on a subscription becomes free revert", () => {
        const inspected = inspectRevenueCatEvent(
            rcEvent({ type: "EXPIRATION", product_id: "zelf_unlimited_1y" }, { zelfName: "alicebob.zelf" })
        );
        expect(inspected).toMatchObject({ ok: true, action: "expire" });
    });

    test("skips unrelated events", () => {
        expect(inspectRevenueCatEvent(rcEvent({ type: "CANCELLATION" })).reason).toBe("ignored_cancellation");
        expect(inspectRevenueCatEvent(rcEvent({ product_id: "zelf_keys_plan" })).reason).toBe("not_zelf_id_product");
    });

    test("sandbox purchases are not credited unless allowed", () => {
        expect(inspectRevenueCatEvent(rcEvent({ environment: "SANDBOX" })).reason).toBe("sandbox_event");
        expect(inspectRevenueCatEvent(rcEvent({ environment: "SANDBOX" }), { allowSandbox: true }).ok).toBe(true);
    });
});

describe("alreadyAppliedToRecord", () => {
    test("matches a stored event id", () => {
        const inspected = { eventId: "evt_1", purchasedAtMs: PURCHASED_AT_MS };
        expect(alreadyAppliedToRecord({ eventID: "evt_1" }, inspected)).toBe(true);
    });
});

describe("webhookHandler", () => {
    beforeEach(() => {
        ZelfIdModule.searchTag.mockReset();
        addDurationToTag.mockReset();
        revertZelfIdToFreePlan.mockReset();
    });

    test("extends the Zelf ID with subscription plan and stores original transaction id", async () => {
        ZelfIdModule.searchTag.mockResolvedValue({
            available: false,
            tagObject: {
                publicData: {
                    tagName: "alicebob.zelf",
                    ethAddress: OWNER.toLowerCase(),
                    registeredAt: "2026-09-01 10:00:00",
                    plan: "free",
                },
            },
        });
        addDurationToTag.mockResolvedValue({ expiresAt: "2027-09-29 21:01:00" });

        const result = await webhookHandler(rcEvent({ product_id: "zelf_unlimited_1y" }));

        expect(result).toMatchObject({ status: "success", action: "zelf_id_lease_extended", duration: "1", plan: "unlimited" });
        expect(addDurationToTag).toHaveBeenCalledWith(
            expect.objectContaining({
                plan: "unlimited",
                revenueCatOriginalTransactionId: "orig_txn_1",
                eventID: "evt_1",
            }),
            expect.any(Object)
        );
    });

    test("reverts to free on subscription expiration", async () => {
        ZelfIdModule.searchTag.mockResolvedValue({
            available: false,
            tagObject: {
                publicData: {
                    tagName: "alicebob.zelf",
                    ethAddress: OWNER,
                    plan: "premium",
                    revenueCatOriginalTransactionId: "orig_txn_1",
                },
            },
        });
        revertZelfIdToFreePlan.mockResolvedValue({ expiresAt: "2126-01-01 00:00:00" });

        const result = await webhookHandler(rcEvent({ type: "EXPIRATION", id: "evt_exp_1" }));

        expect(result).toMatchObject({ action: "zelf_id_reverted_to_free", plan: "free" });
        expect(revertZelfIdToFreePlan).toHaveBeenCalled();
    });

    test("idempotent on duplicate event id", async () => {
        ZelfIdModule.searchTag.mockResolvedValue({
            available: false,
            tagObject: { publicData: { tagName: "alicebob.zelf", ethAddress: OWNER, eventID: "evt_1" } },
        });

        const result = await webhookHandler(rcEvent());

        expect(result).toMatchObject({ action: "already_extended", cache: true });
        expect(addDurationToTag).not.toHaveBeenCalled();
    });

    test("refuses when the RevenueCat owner is not the name owner", async () => {
        ZelfIdModule.searchTag.mockResolvedValue({
            available: false,
            tagObject: { publicData: { tagName: "alicebob.zelf", ethAddress: "0xdead" } },
        });

        await expect(webhookHandler(rcEvent())).rejects.toThrow("409:zelfProof_does_not_match");
    });
});
