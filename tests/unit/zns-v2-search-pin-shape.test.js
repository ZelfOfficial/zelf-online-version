/**
 * IPFS.filter() stores Pinata keyvalues on publicData and removes the top-level keyvalues.
 * Those pins have no metadata object. ZNS v2 search must still return them as taken.
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
	buildTxUrl: jest.fn((id) => `https://arweave.net/${id || "missing"}`),
	buildExplorerUrl: jest.fn((id) => `https://viewblock.io/arweave/tx/${id || "missing"}`),
}));

const axios = require("axios");
const IPFS = require("../../Core/ipfs");
const ArweaveModule = require("../../Repositories/Arweave/modules/arweave.module");
const { formatIPFSRecord } = require("../../Repositories/ZelfNameService/modules/zns-parts.module");
const { searchZelfName } = require("../../Repositories/ZelfNameService/modules/zns-search.module");

const otherSession = {
	typ: "session",
	clientId: "client-other",
	email: "other@example.com",
	tagName: "other.zelf",
};

/**
 * Shape left by Core/ipfs _normalizeFiles for a Pinata v2 list row:
 * keyvalues moved to publicData, metadata absent.
 */
const normalizedPin = (zelfName) => ({
	id: `id-${zelfName}`,
	cid: `bafy${zelfName.replace(".", "")}`,
	ipfs_pin_hash: `bafy${zelfName.replace(".", "")}`,
	name: zelfName,
	url: `https://gateway.pinata.cloud/ipfs/bafy${zelfName.replace(".", "")}`,
	created_at: "2024-06-01T00:00:00.000Z",
	publicData: {
		zelfName,
		tagName: zelfName,
		type: "mainnet",
		zelfProof: "proof+value",
		ethAddress: "0x1111111111111111111111111111111111111111",
		expiresAt: "2099-01-01 00:00:00",
		registeredAt: "2024-06-01 00:00:00",
		hasPassword: "true",
	},
});

const keyvaluesOnlyPin = (zelfName) => ({
	id: `id-raw-${zelfName}`,
	cid: `bafyraw${zelfName.replace(".", "")}`,
	name: `${zelfName}.png`,
	url: `https://gateway.pinata.cloud/ipfs/bafyraw${zelfName.replace(".", "")}`,
	keyvalues: {
		zelfName,
		type: "mainnet",
		zelfProof: "raw proof",
		expiresAt: "2099-01-01 00:00:00",
	},
});

beforeEach(() => {
	IPFS.filter.mockReset();
	ArweaveModule.search.mockReset();
	ArweaveModule.search.mockResolvedValue({ available: true });
	jest.spyOn(axios, "get").mockResolvedValue({ data: Buffer.from("png") });
});

afterEach(() => {
	jest.restoreAllMocks();
});

describe("ZNS v2 search pin shape", () => {
	test("formats a normalized publicData pin that has no metadata", async () => {
		const formatted = await formatIPFSRecord(normalizedPin("miguel.zelf"), true);

		expect(formatted).not.toBeNull();
		expect(formatted.zelfName).toBe("miguel.zelf");
		expect(formatted.publicData.zelfName).toBe("miguel.zelf");
		expect(formatted.publicData.ethAddress).toBe("0x1111111111111111111111111111111111111111");
		expect(formatted.zelfProof).toBe("proof+value");
		expect(formatted.zelfProofQRCode).toMatch(/^data:image\/png;base64,/);
	});

	test.each(["miguel.zelf", "johan.zelf"])("search for %s stays taken when Arweave misses and the pin has only publicData", async (zelfName) => {
		IPFS.filter.mockImplementation(async (_key, value) => (String(value).toLowerCase() === zelfName ? [normalizedPin(zelfName)] : []));

		const result = await searchZelfName({ zelfName }, otherSession);

		expect(result.available).toBe(false);
		expect(result.arweave).toEqual([]);
		expect(result.ipfs).toHaveLength(1);
		expect(result.ipfs[0].zelfName).toBe(zelfName);
		expect(result.ipfs[0].publicData.type).toBe("mainnet");
		expect(result.ipfs[0].zelfProof).toBe("proof+value");
	});

	test("a raw keyvalues pin is kept beside a publicData pin", async () => {
		IPFS.filter.mockImplementation(async (_key, value) =>
			String(value).toLowerCase() === "miguel.zelf" ? [keyvaluesOnlyPin("miguel.zelf"), normalizedPin("miguel.zelf")] : []
		);

		const result = await searchZelfName({ zelfName: "miguel.zelf" }, otherSession);

		expect(result.available).toBe(false);
		expect(result.ipfs.map((row) => row.zelfName)).toEqual(["miguel.zelf", "miguel.zelf"]);
		expect(result.ipfs[0].zelfProof).toBe("raw proof");
	});
});
