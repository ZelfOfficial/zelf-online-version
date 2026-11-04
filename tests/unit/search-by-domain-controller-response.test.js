jest.mock("../../Repositories/Tags/modules/tags.module", () => ({}));
jest.mock("../../Repositories/Tags/modules/tags-search.module", () => ({
    searchByDomain: jest.fn(),
}));
jest.mock("../../Repositories/ZelfID/modules/zelf-id.module", () => ({}));

const TagsSearchModule = require("../../Repositories/Tags/modules/tags-search.module");
const TagsController = require("../../Repositories/Tags/controllers/tags.controller");
const ZelfIdController = require("../../Repositories/ZelfID/controllers/zelf-id.controller");

const makeCtx = (query = {}) => ({
    request: { query },
    state: { user: { tagName: "alice", domain: "zelf" } },
    body: undefined,
    status: 200,
});

describe("search-by-domain controller responses", () => {
    beforeEach(() => {
        TagsSearchModule.searchByDomain.mockReset();
    });

    it("passes incomplete through on tags search-by-domain", async () => {
        TagsSearchModule.searchByDomain.mockResolvedValue({
            rows: [{ name: "a.zelf" }],
            total: 1,
            limit: 50,
            pageOffset: 0,
            incomplete: true,
        });

        const ctx = makeCtx({ domain: "zelf" });
        await TagsController.searchTagsByDomain(ctx);

        expect(ctx.body).toMatchObject({
            data: [{ name: "a.zelf" }],
            total: 1,
            incomplete: true,
        });
    });

    it("omits incomplete when the scan completed", async () => {
        TagsSearchModule.searchByDomain.mockResolvedValue({
            rows: [],
            total: 0,
            limit: 50,
            pageOffset: 0,
        });

        const ctx = makeCtx({ domain: "zelf" });
        await ZelfIdController.searchTagsByDomain(ctx);

        expect(ctx.body.incomplete).toBeUndefined();
    });
});
