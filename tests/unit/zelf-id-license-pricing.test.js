const { Domain } = require("../../Repositories/Tags/modules/domain.class");
const { applyZelfIdPlanPricing, defaultZelfIdPlanPricingTables } = require("../../Repositories/ZelfID/modules/zelf-ids-revenue-cat-products.module");
const { getZelfIdPrice, getZelfIdCheckoutPrice } = require("../../Repositories/ZelfID/modules/zelf-id-plan.module");

// Stale hosted license (shape of the live zelf license on IPFS: premium 6-15 1y = 28).
const staleZelfLicense = () => ({
    name: "zelf",
    tags: {
        payment: {
            rewardPrice: 10,
            whitelist: {},
            pricingTable: { "6-15": { 1: 24, 2: 43, 3: 61, 4: 77, 5: 90, lifetime: 360 }, 4: { 1: 36, lifetime: 540 } },
            planPricing: {
                premium: { "6-15": { 1: 28, 2: 43, 3: 61, 4: 77, 5: 90, lifetime: 360 }, 4: { 1: 36 } },
                unlimited: { "6-15": { 1: 99, 2: 43, 3: 61, 4: 77, 5: 90, lifetime: 360 }, 5: { 1: 150 } },
            },
        },
    },
});

const price = (domain, name, duration, plan) => domain.getPrice(name, duration, "", { plan }).priceWithoutDiscount;

describe("zelf license pricing (code-owned)", () => {
    const domain = new Domain(staleZelfLicense());

    test("premium 6+ chars: 29 / 43.49 / 56.99 / 144.99, ignoring the stale hosted table", () => {
        for (const name of ["abcdef.zelf", "abcdefghijklmno.zelf", "abcdefghijklmnopqrstuvwxyz1.zelf"]) {
            expect(price(domain, name, "1", "premium")).toBe(29);
            expect(price(domain, name, "2", "premium")).toBe(43.49);
            expect(price(domain, name, "3", "premium")).toBe(56.99);
            expect(price(domain, name, "lifetime", "premium")).toBe(144.99);
        }
    });

    test("unlimited every length: 99 / 148.99 / 192.99 / 494.99", () => {
        for (const name of ["a.zelf", "abcde.zelf", "abcdefgh.zelf", "abcdefghijklmnopqrst.zelf"]) {
            expect(price(domain, name, "1", "unlimited")).toBe(99);
            expect(price(domain, name, "2", "unlimited")).toBe(148.99);
            expect(price(domain, name, "3", "unlimited")).toBe(192.99);
            expect(price(domain, name, "lifetime", "unlimited")).toBe(494.99);
        }
    });

    test("no 4 or 5 year options for Zelf ID plans", () => {
        expect(() => price(domain, "abcdefgh.zelf", "4", "premium")).toThrow(/invalid_duration/);
        expect(() => price(domain, "abcdefgh.zelf", "5", "unlimited")).toThrow(/invalid_duration/);
    });

    test("premium is rejected for 1–5 character names", () => {
        expect(() => price(domain, "abcd.zelf", "1", "premium")).toThrow(/premium_requires_6_plus/);
    });

    test("search/checkout quote: short names quote unlimited, long names premium", () => {
        expect(getZelfIdCheckoutPrice({ tagName: "abcdefgh.zelf", domainConfig: domain }).price).toBe(29);
        expect(getZelfIdCheckoutPrice({ tagName: "abc.zelf", domainConfig: domain }).price).toBe(99);
        const shortPremium = getZelfIdPrice({ tagName: "abc.zelf", domainConfig: domain, requestedPlan: "premium" });
        expect(shortPremium.price).toBe(99);
        expect(shortPremium.plan).toBe("unlimited");
        expect(
            getZelfIdCheckoutPrice({ tagName: "abcdefgh.zelf", domainConfig: domain, requestedPlan: "unlimited", duration: "lifetime" }).price
        ).toBe(494.99);
    });

    test("Tags default table (no plan) is unchanged", () => {
        expect(price(domain, "abcdefgh.zelf", "4", undefined)).toBe(77);
    });

    test("other domains keep their license planPricing", () => {
        const other = new Domain({ ...staleZelfLicense(), name: "acme" });
        expect(price(other, "abcdefgh.acme", "1", "premium")).toBe(28);
    });

    test("applyZelfIdPlanPricing rewrites /api/license output for zelf only", () => {
        const lic = applyZelfIdPlanPricing(staleZelfLicense());
        expect(lic.tags.payment.planPricing).toEqual(defaultZelfIdPlanPricingTables());
        expect(lic.tags.payment.planPricing.premium["6-15"]).toEqual({ 1: 29, 2: 43.49, 3: 56.99, lifetime: 144.99 });
        expect(lic.tags.payment.planPricing.premium["5"]).toBeUndefined();
        expect(lic.tags.payment.planPricing.unlimited["5"]).toEqual({ 1: 99, 2: 148.99, 3: 192.99, lifetime: 494.99 });
        const acme = applyZelfIdPlanPricing({ ...staleZelfLicense(), name: "acme" });
        expect(acme.tags.payment.planPricing.premium["6-15"][1]).toBe(28);
    });
});
