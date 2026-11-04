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

describe("TagsIPFSModule.searchByDomain cache", () => {
    beforeEach(() => {
        filterPaged.mockReset();
    });

    it("reuses the filtered row set for subsequent pages within the TTL", async () => {
        const files = Array.from({ length: 30 }, (_, index) => makeFile(`user${index}.zelf`));
        filterPaged.mockResolvedValue({ files, nextPageToken: null });

        const first = await TagsIPFSModule.searchByDomain({ domain: "zelf", limit: 10, pageOffset: 0 });
        const second = await TagsIPFSModule.searchByDomain({ domain: "zelf", limit: 10, pageOffset: 10 });

        expect(first.total).toBe(30);
        expect(second.rows[0].name).toBe("user10.zelf");
        expect(filterPaged).toHaveBeenCalledTimes(1);
    });
});
