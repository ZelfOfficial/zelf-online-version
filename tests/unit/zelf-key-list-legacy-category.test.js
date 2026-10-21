jest.mock("../../Repositories/Tags/modules/tags.module", () => ({
    decryptTag: jest.fn(),
}));

jest.mock("../../Repositories/Tags/modules/tags-parts.module", () => ({
    decryptParams: jest.fn(),
    getFullTagName: jest.fn((tagName, domain) => {
        const resolvedDomain = domain || "zelf";
        if (tagName && tagName.includes(`.${resolvedDomain}`)) return tagName;
        return `${tagName}.${resolvedDomain}`;
    }),
    urlToBase64: jest.fn(),
}));

jest.mock("../../Core/ipfs", () => ({
    filter: jest.fn(),
    getFileById: jest.fn(),
}));

const IPFS = require("../../Core/ipfs");
const ZelfKeyModule = require("../../Repositories/ZelfKeys/modules/zelf-key.module");

describe("ZelfKeys list legacy category prefix", () => {
    const authToken = { tagName: "x.zelf", identifier: "x.zelf", domain: "zelf" };

    beforeEach(() => {
        IPFS.filter.mockReset();
        IPFS.filter.mockImplementation(async (property, value) => {
            if (property === "category" && value === "x.zelf.zelf_password") {
                return [
                    {
                        id: "legacy-pin",
                        cid: "cid-legacy",
                        name: "x.zelf_H1M1",
                        url: "https://example/ipfs/legacy",
                        publicData: {
                            category: "x.zelf.zelf_password",
                            keyOwner: "x.zelf.zelf",
                            type: "password",
                            protection: "face",
                        },
                    },
                ];
            }
            return [];
        });
    });

    it("lists keys stored under legacy x.zelf.zelf_password categories", async () => {
        const result = await ZelfKeyModule.listData({ category: "password" }, authToken);

        expect(result.data).toHaveLength(1);
        expect(result.data[0].id).toBe("legacy-pin");
        expect(IPFS.filter).toHaveBeenCalledWith("category", "x.zelf.zelf_password");
    });
});
