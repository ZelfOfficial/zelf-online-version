/**
 * Arweave gateway misses leave zelfProof null. Formatting that row must not throw,
 * and the IPFS half of ZNS v2 search must still come back.
 */
jest.mock("../../Core/ipfs", () => ({
    filter: jest.fn(),
    retrieve: jest.fn(),
    deleteFiles: jest.fn(async () => null),
}));

jest.mock("../../Repositories/Arweave/modules/arweave.module", () => ({
    search: jest.fn(),
    arweaveIDToBase64: jest.fn(async () => null),
}));

jest.mock("../../Repositories/Arweave/modules/arweave-gateway.module", () => ({
    resolveContentUrl: jest.fn(async (id) => `https://arweave.net/${id || "missing"}`),
    buildExplorerUrl: jest.fn((id) => `https://viewblock.io/arweave/tx/${id || "missing"}`),
}));

const axios = require("axios");
const IPFS = require("../../Core/ipfs");
const ArweaveModule = require("../../Repositories/Arweave/modules/arweave.module");
const { searchZelfName, _returnFormattedArweaveRecords } = require("../../Repositories/ZelfNameService/modules/zns-search.module");

const TAKEN_NAME = "miguel.zelf";

const otherSession = {
    typ: "session",
    clientId: "client-other",
    email: "other@example.com",
    tagName: "other.zelf",
};

const arweaveEdge = (tags) => ({
    node: {
        id: "tx-miguel",
        tags,
    },
});

const nullProofEdge = () =>
    arweaveEdge([
        { name: "zelfName", value: TAKEN_NAME },
        { name: "expiresAt", value: "2099-01-01 00:00:00" },
        { name: "registeredAt", value: "2024-01-01 00:00:00" },
    ]);

const publicData = {
    zelfName: TAKEN_NAME,
    tagName: TAKEN_NAME,
    type: "mainnet",
    plan: "free",
    expiresAt: "2099-01-01 00:00:00",
};

const takenPin = {
    id: "pin-miguel",
    name: TAKEN_NAME,
    ipfs_pin_hash: "bafymiguel",
    publicData: { ...publicData },
    metadata: {
        name: TAKEN_NAME,
        zelfName: TAKEN_NAME,
        keyvalues: { ...publicData },
    },
};

beforeEach(() => {
    IPFS.filter.mockReset();
    ArweaveModule.search.mockReset();
    ArweaveModule.arweaveIDToBase64.mockReset();
    ArweaveModule.arweaveIDToBase64.mockResolvedValue(null);
    jest.spyOn(axios, "get").mockResolvedValue({ data: Buffer.from("png") });
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe("ZNS v2 Arweave formatting", () => {
    test("a null zelfProof is skipped and the result is an empty arweave list", async () => {
        await expect(_returnFormattedArweaveRecords([nullProofEdge()])).resolves.toEqual([]);
    });

    test("a record with missing node fields is skipped", async () => {
        await expect(_returnFormattedArweaveRecords([{}])).resolves.toEqual([]);
    });

    test("a usable record is kept and spaces in zelfProof become plus signs", async () => {
        const rows = await _returnFormattedArweaveRecords([
            arweaveEdge([
                { name: "zelfName", value: TAKEN_NAME },
                { name: "zelfProof", value: "abc def" },
                { name: "expiresAt", value: "2099-01-01 00:00:00" },
                { name: "registeredAt", value: "2024-01-01 00:00:00" },
            ]),
        ]);

        expect(rows).toHaveLength(1);
        expect(rows[0].zelfProof).toBe("abc+def");
        expect(rows[0].zelfName).toBe(TAKEN_NAME);
    });

    test("search still returns the IPFS record when every Arweave row is null", async () => {
        ArweaveModule.search.mockResolvedValue([nullProofEdge()]);
        IPFS.filter.mockImplementation(async (_key, value) => (String(value).toLowerCase() === TAKEN_NAME ? [takenPin] : []));

        const result = await searchZelfName({ zelfName: TAKEN_NAME, environment: "both" }, otherSession);

        expect(result.arweave).toEqual([]);
        expect(result.available).not.toBe(true);
        expect(result.ipfs.map((row) => row.zelfName)).toContain(TAKEN_NAME);
    });
});
