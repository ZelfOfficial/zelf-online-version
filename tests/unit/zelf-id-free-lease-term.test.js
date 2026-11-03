const moment = require("moment");
const TagsIPFSModule = require("../../Repositories/Tags/modules/tags-ipfs.module");
const { confirmZelfId } = require("../../Repositories/ZelfID/modules/zelf-ids-registration.module");
const { applyAvailableNameOffer, freeTermYearsForName } = require("../../Repositories/ZelfID/modules/zelf-id-plan.module");

const domainConfig = {
    name: "zelf",
    getTagKey: () => "tagName",
    isArweaveEnabled: () => false,
    tags: {
        payment: {
            planPricing: {
                premium: { "6-27": { 1: 29, 4: 69.49, 5: 80.99, lifetime: 144.99 } },
                unlimited: { "1-27": { 1: 99, 4: 236.99, 5: 276.99, lifetime: 494.99 } },
            },
        },
    },
};

const yearsUntil = (expiresAt) => moment.utc(expiresAt, "YYYY-MM-DD HH:mm:ss", true).diff(moment.utc(), "years", true);

const leaseFree = async (tagName) => {
    let reserved;
    jest.spyOn(TagsIPFSModule, "insertSearchablePins").mockImplementation(async (data) => {
        reserved = data.reserved;
        return { id: "pin", publicData: { tagName: data.name } };
    });
    await confirmZelfId(
        { tagName, domain: "zelf", zelfProofQRCode: "qr", hasPassword: "false", price: 0 },
        null,
        domainConfig,
        "",
        { pro: true },
        { plan: "free" }
    );
    return JSON.parse(reserved.extraParams);
};

describe("new free leases follow the short-name hold", () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test("a 4-character free lease expires in about 1 year", async () => {
        const extra = await leaseFree("abcd");
        const offer = applyAvailableNameOffer({ available: true }, { tagName: "abcd", domainConfig, duration: "1" });

        expect(extra.plan).toBe("free");
        expect(Number(extra.duration)).toBe(1);
        expect(Number(extra.duration)).toBe(freeTermYearsForName("abcd", domainConfig));
        expect(offer.plans.free.termYears).toBe(1);
        expect(offer.eligibility.freeTermYears).toBe(1);
        expect(yearsUntil(extra.expiresAt)).toBeGreaterThan(0.9);
        expect(yearsUntil(extra.expiresAt)).toBeLessThan(1.2);
    });

    test("a 12-character free lease expires in about 100 years", async () => {
        const extra = await leaseFree("abcdefghijkl");
        const offer = applyAvailableNameOffer({ available: true }, { tagName: "abcdefghijkl", domainConfig, duration: "1" });

        expect(extra.plan).toBe("free");
        expect(Number(extra.duration)).toBe(100);
        expect(Number(extra.duration)).toBe(freeTermYearsForName("abcdefghijkl", domainConfig));
        expect(offer.plans.free.termYears).toBe(100);
        expect(offer.eligibility.freeTermYears).toBe(100);
        expect(yearsUntil(extra.expiresAt)).toBeGreaterThan(99);
        expect(yearsUntil(extra.expiresAt)).toBeLessThan(101);
    });

    test("a paid plan passed to confirmZelfId keeps the 1-year stamp", async () => {
        let reserved;
        jest.spyOn(TagsIPFSModule, "insertSearchablePins").mockImplementation(async (data) => {
            reserved = data.reserved;
            return { id: "pin" };
        });
        await confirmZelfId(
            { tagName: "abcdefghijkl", domain: "zelf", zelfProofQRCode: "qr", hasPassword: "false", price: 29 },
            null,
            domainConfig,
            "",
            { pro: true },
            { plan: "premium" }
        );
        const extra = JSON.parse(reserved.extraParams);
        expect(extra.plan).toBe("premium");
        expect(Number(extra.duration)).toBe(1);
        expect(yearsUntil(extra.expiresAt)).toBeGreaterThan(0.9);
        expect(yearsUntil(extra.expiresAt)).toBeLessThan(1.2);
    });
});
