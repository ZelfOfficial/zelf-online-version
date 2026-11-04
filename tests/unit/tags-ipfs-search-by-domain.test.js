jest.mock("../../Repositories/Tags/config/supported-domains", () => ({
    getDomainConfig: () => ({ domain: "zelf" }),
}));

jest.mock("../../Core/ipfs", () => ({
    filterPaged: jest.fn(),
}));

const IPFS = require("../../Core/ipfs");
const TagsIPFSModule = require("../../Repositories/Tags/modules/tags-ipfs.module");

const makeFile = (name, domain = "zelf") => ({
    id: `id-${name}`,
    cid: `cid-${name}`,
    name,
    metadata: {
        keyvalues: {
            domain,
            zelfName: name,
            type: "tag",
        },
    },
});

describe("TagsIPFSModule.searchByDomain pagination", () => {
    beforeEach(() => {
        IPFS.filterPaged.mockReset();
    });

    it("honors limit and pageOffset and returns total across pages", async () => {
        const files = Array.from({ length: 120 }, (_, index) => makeFile(`user${index}.zelf`));

        IPFS.filterPaged
            .mockResolvedValueOnce({ files: files.slice(0, 100), nextPageToken: "page-2" })
            .mockResolvedValueOnce({ files: files.slice(100), nextPageToken: null });

        const result = await TagsIPFSModule.searchByDomain({ domain: "zelf", limit: 10, pageOffset: 10 });

        expect(result.total).toBe(120);
        expect(result.limit).toBe(10);
        expect(result.pageOffset).toBe(10);
        expect(result.rows).toHaveLength(10);
        expect(result.rows[0].name).toBe("user10.zelf");
    });
});
