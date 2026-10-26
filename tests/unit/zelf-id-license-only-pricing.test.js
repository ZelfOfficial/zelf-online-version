const { Domain } = require("../../Repositories/Tags/modules/domain.class");
const { getZelfIdCheckoutPrice, getZelfIdPrice, assertLicenseOffersPlan } = require("../../Repositories/ZelfID/modules/zelf-id-plan.module");

const P = { 1: 29, 2: 43.49, 3: 56.99, lifetime: 144.99 };
const U = { 1: 99, 2: 148.99, 3: 192.99, lifetime: 494.99 };
const license = (planPricing) =>
    new Domain({
        name: "zelf",
        tags: {
            payment: {
                rewardPrice: 10,
                whitelist: {},
                pricingTable: { "6-15": { 1: 24, 2: 43, 3: 61, 4: 77, 5: 90, lifetime: 360 }, 4: { 1: 36, 4: 115 } },
                planPricing,
            },
        },
    });
const live = () => license({ premium: { "6-15": P, "16-27": P }, unlimited: { 1: U, 2: U, 3: U, 4: U, 5: U, "6-15": U, "16-27": U } });
const price = (d, name, duration, plan) => d.getPrice(name, duration, "", { plan }).priceWithoutDiscount;

describe("Zelf ID plan prices come only from license planPricing", () => {
    test("every length and duration matches the license", () => {
        const d = live();
        for (const name of ["abcdef", "abcdefghij", "abcdefghijklmno", "abcdefghijklmnop", "abcdefghijklmnopqrstuvwxyza"]) {
            for (const [k, v] of Object.entries(P)) expect(price(d, `${name}.zelf`, k, "premium")).toBe(v);
        }
        for (const name of ["a", "abc", "abcde", "abcdefghij", "abcdefghijklmnopqrst"]) {
            for (const [k, v] of Object.entries(U)) expect(price(d, `${name}.zelf`, k, "unlimited")).toBe(v);
        }
    });

    test("no fallback to the Tags pricingTable or the hardcoded 24", () => {
        const d = live();
        expect(() => price(d, "abcdefgh.zelf", "4", "premium")).toThrow("409:PLAN_DURATION_NOT_OFFERED_BY_LICENSE");
        expect(() => price(d, "abcd.zelf", "1", "premium")).toThrow("409:PLAN_DURATION_NOT_OFFERED_BY_LICENSE");
        const empty = license(undefined);
        expect(() => price(empty, "abcdefgh.zelf", "1", "premium")).toThrow("409:PLAN_DURATION_NOT_OFFERED_BY_LICENSE");
    });

    test("Tags (no plan) still use pricingTable", () => {
        expect(price(live(), "abcdefgh.zelf", "4", undefined)).toBe(77);
    });

    test("durations are derived from the license cells", () => {
        const d = live();
        expect(d.licensePlanDurations("premium", 8).sort()).toEqual(["1", "2", "3", "lifetime"]);
        expect(d.licensePlanDurations("premium", 5)).toEqual([]);
        expect(d.licensePlanDurations("unlimited", 3).sort()).toEqual(["1", "2", "3", "lifetime"]);
        const withFour = license({ premium: { "6-15": { ...P, 4: 70 } } });
        expect(withFour.licensePlanDurations("premium", 8)).toContain("4");
        expect(price(withFour, "abcdefgh.zelf", "4", "premium")).toBe(70);
    });

    test("assertLicenseOffersPlan rejects 4/5y and premium on 1–5", () => {
        const d = live();
        expect(() => assertLicenseOffersPlan({ domainConfig: d, tagName: "abcdefgh.zelf", plan: "premium", duration: "4" })).toThrow(
            "409:PLAN_DURATION_NOT_OFFERED_BY_LICENSE"
        );
        expect(() => assertLicenseOffersPlan({ domainConfig: d, tagName: "abcde.zelf", plan: "premium", duration: "1" })).toThrow(
            "409:PLAN_NOT_OFFERED_FOR_NAME"
        );
        expect(() => assertLicenseOffersPlan({ domainConfig: d, tagName: "abcde.zelf", plan: "unlimited", duration: "999" })).not.toThrow();
    });

    test("search/checkout quotes", () => {
        const d = live();
        expect(getZelfIdCheckoutPrice({ tagName: "abcdefgh.zelf", duration: "1", domainConfig: d }).price).toBe(29);
        expect(getZelfIdCheckoutPrice({ tagName: "abc.zelf", duration: "lifetime", domainConfig: d }).price).toBe(494.99);
        expect(() => getZelfIdCheckoutPrice({ tagName: "abcdefgh.zelf", duration: "4", domainConfig: d })).toThrow("409:");
        expect(() => getZelfIdPrice({ tagName: "abc.zelf", duration: "1", domainConfig: d, requestedPlan: "premium" })).toThrow("409:");
    });

    test("lease-time getZelfIdPrice ignores legacy 10% referral discount when referrer is not whitelisted", () => {
        const d = live();
        const quote = getZelfIdPrice({
            tagName: "abcdefgh.zelf",
            duration: "1",
            referralTagName: "jim.zelf",
            domainConfig: d,
        });
        expect(quote.discount).toBe(0);
        expect(quote.price).toBe(quote.priceWithoutDiscount);
    });

    test("Zelf ID plan quotes ignore legacy 10% referral discount when referrer is not whitelisted", () => {
        const d = live();
        const bare = "jim";
        const q = d.getPrice("abcdefgh", "1", `${bare}.zelf`, { plan: "unlimited" });
        expect(q.priceWithoutDiscount).toBe(99);
        expect(q.price).toBe(99);
        expect(q.discount).toBe(0);
    });

    test("purchase reward uses license rewardPrice on the list amount for Zelf ID plans", () => {
        const d = license({
            premium: { "6-15": P, "16-27": P },
            unlimited: { 1: U, 2: U, 3: U, 4: U, 5: U, "6-15": U, "16-27": U },
        });
        const atTen = d.getPrice("abcdefgh", "1", "", { plan: "unlimited" });
        expect(atTen.reward).toBe(9.9);

        const atFifteen = license({
            premium: { "6-15": P, "16-27": P },
            unlimited: { 1: U, 2: U, 3: U, 4: U, 5: U, "6-15": U, "16-27": U },
        });
        atFifteen.tags.payment.rewardPrice = 15;
        const reward15 = atFifteen.getPrice("abcdefgh", "1", "", { plan: "unlimited" });
        expect(reward15.reward).toBe(6.6);
    });

    test("whitelist coupon zeros billable price but list reward stays on pre-discount license price", () => {
        const d = new Domain({
            name: "zelf",
            tags: {
                payment: {
                    rewardPrice: 10,
                    whitelist: { "coupon.zelf": "100%" },
                    pricingTable: {},
                    planPricing: { premium: { "6-15": P }, unlimited: { "6-15": U } },
                },
            },
        });
        const q = d.getPrice("abcdefgh", "1", "coupon.zelf", { plan: "unlimited" });
        expect(q.priceWithoutDiscount).toBe(99);
        expect(q.price).toBe(0);
        expect(q.reward).toBe(9.9);
    });
});

describe("license cache TTL", () => {
    test("short TTL and separate key from the License module", () => {
        const sd = require("../../Repositories/Tags/config/supported-domains");
        expect(sd.LICENSE_CACHE_TTL_SECONDS).toBe(60);
        const { initCacheInstance } = require("../../cache/manager");
        sd.upsertCachedDomain({ name: "ttltest", status: "active", tags: { payment: { planPricing: { premium: { "6-15": P } } } } });
        const cache = initCacheInstance();
        const ttl = cache.getTtl("official-license-domains");
        expect(ttl - Date.now()).toBeLessThanOrEqual(60 * 1000);
        expect(cache.get("official-licenses")).toBeUndefined();
    });
});
