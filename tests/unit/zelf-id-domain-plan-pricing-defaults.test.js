const { Domain } = require("../../Repositories/Tags/modules/domain.class");

describe("zelf plan pricing comes only from the license", () => {
    test("no code override: missing planPricing never yields hardcoded USD", () => {
        const domain = new Domain({ name: "zelf", tags: { payment: { pricingTable: { "6-15": { 1: 24, lifetime: 360 } } } } });
        expect(domain.licensePlanPrice("premium", 8, "1")).toBeUndefined();
        expect(domain.licenseOffersPlan("unlimited", 4)).toBe(false);
    });

    test("reads license planPricing including range keys like 16-27", () => {
        const domain = new Domain({
            name: "zelf",
            tags: { payment: { planPricing: { premium: { "6-15": { 1: 29 }, "16-27": { 1: 29, lifetime: 144.99 } } } } },
        });
        expect(domain.licensePlanPrice("premium", 20, "lifetime")).toBe(144.99);
        expect(domain.licensePlanPrice("premium", 8, "1")).toBe(29);
        expect(domain.licenseOffersPlan("premium", 5)).toBe(false);
    });
});
