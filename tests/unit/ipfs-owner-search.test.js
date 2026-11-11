jest.mock("../../Core/ipfs", () => ({
    filter: jest.fn(),
    retrieve: jest.fn(),
}));

const IPFS = require("../../Core/ipfs");
const { TOKEN_TYPES } = require("../../Core/jwt-claims");
const { get } = require("../../Repositories/IPFS/modules/ipfs.module");

const receipt = (email) => ({
    name: "presale_receipt.json",
    publicData: {
        type: "presale_receipt",
        presaleSessionId: "cs_test_other",
        presaleEmail: email,
    },
});

beforeEach(() => {
    IPFS.filter.mockReset();
    IPFS.filter.mockResolvedValue([receipt("buyer@example.com"), receipt("owner@client.test")]);
});

describe("protected IPFS key search", () => {
    test("internal lookups without a caller still return the filter result", async () => {
        const rows = await get({ key: "presaleSessionId", value: "cs_test_other" });
        expect(rows).toHaveLength(2);
    });

    test("a client token only receives records that belong to that caller", async () => {
        const rows = await get({ key: "presaleSessionId", value: "cs_test_other" }, { clientId: "client-1", email: "owner@client.test" });

        expect(rows).toEqual([receipt("owner@client.test")]);
    });

    test("a super-admin token can read the full result", async () => {
        const rows = await get(
            { key: "presaleSessionId", value: "cs_test_other" },
            { clientId: "client-1", email: "admin@zelf.test", typ: TOKEN_TYPES.superAdmin, superAdminId: "admin-1" }
        );

        expect(rows).toHaveLength(2);
    });
});
