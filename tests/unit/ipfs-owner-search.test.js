jest.mock("../../Core/ipfs", () => ({
    filter: jest.fn(),
    retrieve: jest.fn(),
}));

const IPFS = require("../../Core/ipfs");
const { TOKEN_TYPES } = require("../../Core/jwt-claims");
const { get: getRecords } = require("../../Repositories/IPFS/modules/ipfs.module");
const { get: getRoute } = require("../../Repositories/IPFS/controllers/ipfs.controller");

const receipt = (email) => ({
    name: "presale_receipt.json",
    publicData: {
        type: "presale_receipt",
        presaleSessionId: "cs_test_other",
        presaleEmail: email,
    },
});

const query = { key: "presaleSessionId", value: "cs_test_other" };

const routeContext = (user, requestQuery = query) => ({
    request: { query: requestQuery },
    state: { user },
});

beforeEach(() => {
    IPFS.filter.mockReset();
    IPFS.retrieve.mockReset();
    IPFS.filter.mockResolvedValue([receipt("buyer@example.com"), receipt("owner@client.test")]);
});

describe("IPFSModule.get stays unfiltered for internal callers", () => {
    test("a lookup without a caller returns the filter result", async () => {
        const rows = await getRecords(query);

        expect(rows).toHaveLength(2);
    });

    test("a normal session passed as the second argument does not drop other owners", async () => {
        const rows = await getRecords(query, { clientId: "client-1", email: "owner@client.test", typ: TOKEN_TYPES.session });

        expect(rows).toHaveLength(2);
    });
});

describe("GET /api/ipfs owner filter", () => {
    test("a normal session receives only records that belong to that caller", async () => {
        const ctx = routeContext({ clientId: "client-1", email: "owner@client.test", typ: TOKEN_TYPES.session });

        await getRoute(ctx);

        expect(ctx.body.data).toEqual([receipt("owner@client.test")]);
    });

    test("a caller with no matching identity receives an empty list", async () => {
        const ctx = routeContext({ clientId: "client-2", email: "stranger@example.com", tagName: "stranger.zelf", typ: TOKEN_TYPES.session });

        await getRoute(ctx);

        expect(ctx.body.data).toEqual([]);
    });

    test("a super-admin token receives the full result", async () => {
        const ctx = routeContext({
            clientId: "client-1",
            email: "admin@zelf.test",
            typ: TOKEN_TYPES.superAdmin,
            superAdminId: "admin-1",
        });

        await getRoute(ctx);

        expect(ctx.body.data).toHaveLength(2);
    });

    test("a superAdminId bypasses the owner filter", async () => {
        const ctx = routeContext({ clientId: "client-1", email: "admin@zelf.test", superAdminId: "admin-1" });

        await getRoute(ctx);

        expect(ctx.body.data).toHaveLength(2);
    });
});
