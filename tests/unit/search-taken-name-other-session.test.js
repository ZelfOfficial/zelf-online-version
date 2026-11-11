/**
 * A normal session looking up someone else's name must still see that name as taken.
 * ZNS v2 passes the session into IPFSModule.get. Tags and Zelf ID search share the
 * same IPFS index. Neither path may hide a stored record because the caller owns a different name.
 */
process.env.SOLANA_TOKEN_MINT_ADDRESS = process.env.SOLANA_TOKEN_MINT_ADDRESS || "11111111111111111111111111111111";

jest.mock("../../Repositories/Wallet/modules/stellar", () => ({
    createStellarWallet: jest.fn(),
    healPublicDataXlm: jest.fn(),
}));

jest.mock("../../Core/ipfs", () => ({
    filter: jest.fn(),
    retrieve: jest.fn(),
    deleteFiles: jest.fn(),
}));

jest.mock("../../Repositories/Arweave/modules/arweave.module", () => {
    const actual = jest.requireActual("../../Repositories/Arweave/modules/arweave.module");

    return {
        ...actual,
        search: jest.fn(async () => ({ available: true })),
    };
});

const axios = require("axios");
const IPFS = require("../../Core/ipfs");
const IPFSModule = require("../../Repositories/IPFS/modules/ipfs.module");
const { searchZelfName } = require("../../Repositories/ZelfNameService/modules/zns.v2.module");
const { searchTag } = require("../../Repositories/Tags/modules/tags-search.module");
const { searchTag: searchZelfId } = require("../../Repositories/ZelfID/modules/zelf-id.module");

const TAKEN_NAME = "miguel.zelf";

const otherSession = {
    typ: "session",
    clientId: "client-other",
    email: "other@example.com",
    tagName: "other.zelf",
    identifier: "other.zelf",
    ethAddress: "0x2222222222222222222222222222222222222222",
};

const publicData = {
    zelfName: TAKEN_NAME,
    tagName: TAKEN_NAME,
    type: "mainnet",
    plan: "free",
    ethAddress: "0x1111111111111111111111111111111111111111",
    aptosAddress: "0xaptosmiguel",
    dotAddress: "5MiguelDotAddress",
    ksmAddress: "MiguelKsmAddress",
    expiresAt: "2099-01-01 00:00:00",
};

const takenPin = {
    id: "pin-miguel",
    name: TAKEN_NAME,
    ipfs_pin_hash: "bafymiguel",
    cid: "bafymiguel",
    url: "",
    publicData: { ...publicData },
    keyvalues: { ...publicData },
    metadata: {
        name: TAKEN_NAME,
        zelfName: TAKEN_NAME,
        keyvalues: { ...publicData },
    },
};

const domainConfig = {
    name: "zelf",
    tags: {
        storage: {
            ipfsEnabled: true,
            arweaveEnabled: false,
            keyPrefix: "tagName",
        },
    },
};

beforeEach(() => {
    IPFS.filter.mockReset();
    IPFS.filter.mockImplementation(async (_key, value) => (String(value).toLowerCase() === TAKEN_NAME ? [takenPin] : []));
    jest.spyOn(axios, "get").mockResolvedValue({ data: Buffer.from("png") });
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe("taken name stays unavailable for a different session", () => {
    test("ZNS v2 search reports miguel.zelf as taken", async () => {
        const getSpy = jest.spyOn(IPFSModule, "get");

        const result = await searchZelfName({ zelfName: "miguel.zelf", environment: "both" }, otherSession);

        expect(getSpy).toHaveBeenCalledWith(expect.objectContaining({ key: "zelfName", value: TAKEN_NAME }), otherSession);
        expect(result?.available).not.toBe(true);
        expect(result.ipfs.map((row) => row.zelfName)).toContain(TAKEN_NAME);
    });

    test("tags search reports miguel.zelf as taken", async () => {
        const result = await searchTag(
            {
                tagName: TAKEN_NAME,
                domain: "zelf",
                environment: "ipfs",
                type: "mainnet",
                domainConfig,
            },
            otherSession
        );

        expect(result.available).toBe(false);
        expect(result.tagObject.publicData.tagName).toBe(TAKEN_NAME);
    });

    test("zelf-ids search reports miguel.zelf as taken", async () => {
        const result = await searchZelfId(
            {
                tagName: "miguel",
                domain: "zelf",
                environment: "ipfs",
                type: "mainnet",
                domainConfig,
            },
            otherSession
        );

        expect(result.available).toBe(false);
        expect(result.tagObject.publicData.tagName).toBe(TAKEN_NAME);
    });
});
