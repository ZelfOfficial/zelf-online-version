jest.mock("../../Core/ipfs", () => ({
    filter: jest.fn(),
    retrieve: jest.fn(),
}));

jest.mock("../../Repositories/Tags/config/supported-domains", () => ({
    getDomainConfig: jest.fn(() => null),
}));

jest.mock("../../Repositories/Tags/modules/domain-registry.module", () => ({
    generateStorageKey: jest.fn(() => "tagName"),
}));

const IPFS = require("../../Core/ipfs");
const TagsIPFSModule = require("../../Repositories/Tags/modules/tags-ipfs.module");

const domainConfig = { name: "avax", tags: { storage: { keyPrefix: "tagName" } } };

const pin = (name, keyvalues) => ({
    id: `id_${name}`,
    name,
    cid: `cid_${name}`,
    created_at: "2026-09-01T20:10:20Z",
    keyvalues,
});

describe("Tags IPFS get: name fallback", () => {
    beforeEach(() => jest.clearAllMocks());

    it("does not return a Zelf Keys item pinned as <tag>_<suffix> as if it were the tag", async () => {
        // No record under the storage key nor zelfName: only the Pinata name matches.
        IPFS.filter.mockImplementation(async (property) => {
            if (property !== "name") return [];
            return [pin("bas.avax_H9M36", { type: "credit_card", zelfName: "bas.avax" })];
        });

        const result = await TagsIPFSModule.get({ tagName: "bas.avax", domainConfig });

        expect(IPFS.filter).toHaveBeenCalledWith("name", "bas.avax", { throwOnError: true });
        expect(result).toEqual([]);
    });

    it.each(["password", "notes", "credit_card", "contact", "zotp"])("skips Zelf Keys type %s", async (type) => {
        IPFS.filter.mockImplementation(async (property) => (property === "name" ? [pin("bas.avax_AB12C", { type })] : []));

        await expect(TagsIPFSModule.get({ tagName: "bas.avax", domainConfig })).resolves.toEqual([]);
    });

    it("keeps a legacy tag pin found only by name", async () => {
        IPFS.filter.mockImplementation(async (property) => {
            if (property !== "name") return [];
            return [
                pin("bas.avax_H9M36", { type: "credit_card" }),
                pin("bas.avax.hold", { type: "hold", ethAddress: "0x9632", extraParams: JSON.stringify({ expiresAt: "2027-10-01 00:00:00" }) }),
            ];
        });

        const result = await TagsIPFSModule.get({ tagName: "bas.avax", domainConfig });

        expect(result).toHaveLength(1);
        expect(result[0].name).toBe("bas.avax.hold");
    });
});
