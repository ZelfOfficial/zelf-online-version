/**
 * A pin with no metadata used to throw inside formatIPFSRecord and discard every IPFS row.
 * The bad row is skipped. A remaining valid row still marks the name taken.
 */
jest.mock("../../Core/ipfs", () => ({
    filter: jest.fn(),
    retrieve: jest.fn(),
    deleteFiles: jest.fn(async () => null),
}));

jest.mock("../../Repositories/Arweave/modules/arweave.module", () => ({
    search: jest.fn(async () => ({ available: true })),
    arweaveIDToBase64: jest.fn(async () => null),
}));

jest.mock("../../Repositories/Arweave/modules/arweave-gateway.module", () => ({
    resolveContentUrl: jest.fn(async (id) => `https://arweave.net/${id || "missing"}`),
    buildExplorerUrl: jest.fn((id) => `https://viewblock.io/arweave/tx/${id || "missing"}`),
}));

const axios = require("axios");
const IPFS = require("../../Core/ipfs");
const { formatIPFSRecord } = require("../../Repositories/ZelfNameService/modules/zns-parts.module");
const { searchZelfName, _returnFormattedIPFSRecords } = require("../../Repositories/ZelfNameService/modules/zns-search.module");

const TAKEN_NAME = "miguel.zelf";

const otherSession = {
    typ: "session",
    clientId: "client-other",
    email: "other@example.com",
    tagName: "other.zelf",
};

const publicData = {
    zelfName: TAKEN_NAME,
    tagName: TAKEN_NAME,
    type: "mainnet",
    plan: "free",
    expiresAt: "2099-01-01 00:00:00",
};

const validPin = {
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

const brokenPin = {
    id: "pin-broken",
    name: TAKEN_NAME,
    ipfs_pin_hash: "bafybroken",
};

beforeEach(() => {
    IPFS.filter.mockReset();
    jest.spyOn(axios, "get").mockResolvedValue({ data: Buffer.from("png") });
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe("ZNS v2 IPFS formatting", () => {
    test("formatIPFSRecord returns null when metadata is missing", async () => {
        await expect(formatIPFSRecord(brokenPin, true)).resolves.toBeNull();
        await expect(formatIPFSRecord({}, true)).resolves.toBeNull();
    });

    test("a malformed pin is skipped and the valid pin is kept", async () => {
        const rows = await _returnFormattedIPFSRecords([brokenPin, validPin], "both", true);

        expect(rows).toHaveLength(1);
        expect(rows[0].zelfName).toBe(TAKEN_NAME);
    });

    test("search reports available false when a valid record survives a malformed one", async () => {
        IPFS.filter.mockImplementation(async (_key, value) => (String(value).toLowerCase() === TAKEN_NAME ? [brokenPin, validPin] : []));

        const result = await searchZelfName({ zelfName: TAKEN_NAME, environment: "both" }, otherSession);

        expect(result.available).toBe(false);
        expect(result.ipfs.map((row) => row.zelfName)).toEqual([TAKEN_NAME]);
    });
});
