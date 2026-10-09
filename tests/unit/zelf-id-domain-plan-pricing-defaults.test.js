const { Domain } = require("../../Repositories/Tags/modules/domain.class");

describe("zelf domain default in-app planPricing", () => {
    test("falls back to subscription USD table when license omits planPricing", () => {
        const domain = new Domain({
            name: "zelf",
            tags: {
                payment: {
                    pricingTable: {
                        "6-15": { 1: 24, lifetime: 360 },
                    },
                },
            },
        });

        expect(domain._lookupTablePrice(domain._pricingTableForPlan("premium"), 8, "2")).toBe(43.49);
        expect(domain._lookupTablePrice(domain._pricingTableForPlan("unlimited"), 4, "1")).toBe(99);
        expect(domain._lookupTablePrice(domain._pricingTableForPlan("unlimited"), 8, "lifetime")).toBe(494.99);
    });
});
