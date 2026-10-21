jest.mock("../../Repositories/Tags/config/supported-domains", () => ({
    getDomainConfig: () => ({ domain: "zelf" }),
}));

const filterPaged = jest.fn();
jest.mock("../../Core/ipfs", () => ({
    filterPaged: (...args) => filterPaged(...args),
}));

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

describe("TagsIPFSModule.searchByDomain incomplete scan", () => {
    beforeEach(() => {
        filterPaged.mockReset();
    });

    it("returns incomplete and does not cache when a page fetch fails after retry", async () => {
        const files = Array.from({ length: 5 }, (_, index) => makeFile(`user${index}.zelf`));
        filterPaged
            .mockResolvedValueOnce({ files, nextPageToken: "page-2" })
            .mockRejectedValueOnce(new Error("fetch failed"))
            .mockRejectedValueOnce(new Error("fetch failed"));

        const first = await TagsIPFSModule.searchByDomain({ domain: "zelf", limit: 50, pageOffset: 0 });
        expect(first.incomplete).toBe(true);
        expect(first.total).toBe(5);

        filterPaged.mockReset();
        filterPaged.mockResolvedValue({ files: [makeFile("fresh.zelf")], nextPageToken: null });

        const second = await TagsIPFSModule.searchByDomain({ domain: "zelf", limit: 50, pageOffset: 0 });
        expect(filterPaged).toHaveBeenCalled();
        expect(second.rows.some((row) => row.name === "fresh.zelf")).toBe(true);
    });
});
