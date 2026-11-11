const {
    sanitizePinataKeyvalues,
    buildPinataListQuery,
    sanitizePinataPageLimit,
    filter,
    filterPaged,
} = require("../../Core/ipfs");

describe("Pinata list filter helper", () => {
    describe("sanitizePinataKeyvalues", () => {
        it("drops undefined and null values and keeps defined ones unchanged", () => {
            const cleaned = sanitizePinataKeyvalues({
                name: "alice.zelf",
                tagName: undefined,
                zelfName: null,
                owner: "0xabc",
                count: 0,
                active: false,
                note: "",
            });

            expect(cleaned).toEqual({
                name: "alice.zelf",
                owner: "0xabc",
                count: 0,
                active: false,
                note: "",
            });
        });

        it("returns null when every value is missing", () => {
            expect(sanitizePinataKeyvalues({ owner: undefined, tagName: null })).toBeNull();
            expect(sanitizePinataKeyvalues(undefined)).toBeNull();
            expect(sanitizePinataKeyvalues(null)).toBeNull();
            expect(sanitizePinataKeyvalues(["owner"])).toBeNull();
        });
    });

    describe("buildPinataListQuery", () => {
        it("keeps a valid name, cid, and keyvalue exactly", () => {
            expect(buildPinataListQuery("name", "alice.zelf")).toEqual({ mode: "name", value: "alice.zelf" });
            expect(buildPinataListQuery("cid", "bafybeigdyrzt")).toEqual({ mode: "cid", value: "bafybeigdyrzt" });
            expect(buildPinataListQuery("owner", "0xabc")).toEqual({
                mode: "keyvalues",
                keyvalues: { owner: "0xabc" },
            });
            expect(buildPinataListQuery("tagName", "alice.zelfkeys")).toEqual({
                mode: "keyvalues",
                keyvalues: { tagName: "alice.zelfkeys" },
            });
        });

        it("refuses a missing name or cid instead of listing every file", () => {
            expect(buildPinataListQuery("name", undefined)).toBeNull();
            expect(buildPinataListQuery("name", null)).toBeNull();
            expect(buildPinataListQuery("name", "")).toBeNull();
            expect(buildPinataListQuery("cid", undefined)).toBeNull();
            expect(buildPinataListQuery("cid", null)).toBeNull();
            expect(buildPinataListQuery("cid", "")).toBeNull();
        });

        it("refuses a keyvalue whose value is undefined or null", () => {
            expect(buildPinataListQuery("owner", undefined)).toBeNull();
            expect(buildPinataListQuery("zelfName", null)).toBeNull();
            expect(buildPinataListQuery("tagName", undefined)).toBeNull();
            expect(buildPinataListQuery(undefined, "alice.zelf")).toBeNull();
            expect(buildPinataListQuery("", "alice.zelf")).toBeNull();
        });
    });

    describe("sanitizePinataPageLimit", () => {
        it("uses the fallback for a missing limit and keeps a valid page size", () => {
            expect(sanitizePinataPageLimit(undefined, 100)).toBe(100);
            expect(sanitizePinataPageLimit(null, 100)).toBe(100);
            expect(sanitizePinataPageLimit("", 100)).toBe(100);
            expect(sanitizePinataPageLimit(Number.NaN, 100)).toBe(100);
            expect(sanitizePinataPageLimit(50, 100)).toBe(50);
            expect(sanitizePinataPageLimit("25", 100)).toBe(25);
            expect(sanitizePinataPageLimit(250, 100)).toBe(100);
        });
    });

    describe("filter and filterPaged", () => {
        it("returns an empty result when the required filter is absent", async () => {
            await expect(filter("name", undefined)).resolves.toEqual([]);
            await expect(filter("cid", null)).resolves.toEqual([]);
            await expect(filter("owner", undefined)).resolves.toEqual([]);
            await expect(filter("tagName", null)).resolves.toEqual([]);
            await expect(filter()).resolves.toEqual([]);
            await expect(filterPaged("category", undefined)).resolves.toEqual({ files: [], nextPageToken: null });
            await expect(filterPaged("cid", "")).resolves.toEqual({ files: [], nextPageToken: null });
        });
    });
});
