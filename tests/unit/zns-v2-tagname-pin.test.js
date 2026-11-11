/**
 * Tags indexes a Zelf ID on `tagName`. Older ZNS pins use `zelfName`.
 * A tagName-only pin has no zelfName key. The file name ends in .png,
 * and the lease date in extraParams can already be in the past.
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
const { searchZelfName } = require("../../Repositories/ZelfNameService/modules/zns-search.module");

const otherSession = {
	typ: "session",
	clientId: "client-other",
	email: "other@example.com",
	tagName: "other.zelf",
};

const johanPin = {
	id: "pin-johan",
	cid: "bafyjohan",
	ipfs_pin_hash: "bafyjohan",
	name: "johan.zelf.png",
	url: "https://gateway.pinata.cloud/ipfs/bafyjohan",
	publicData: {
		tagName: "johan.zelf",
		domain: "zelf",
		type: "mainnet",
		ethAddress: "0x0000000000000000000000000000000000000001",
		extraParams: JSON.stringify({
			expiresAt: "2020-01-01 00:00:00",
			registeredAt: "2019-01-01 00:00:00",
			hasPassword: "true",
			origin: "online",
			v: 4,
		}),
	},
};

beforeEach(() => {
	IPFS.filter.mockReset();
	jest.spyOn(axios, "get").mockResolvedValue({ data: Buffer.from("png") });
});

afterEach(() => {
	jest.restoreAllMocks();
});

describe("ZNS v2 finds the same pins as tags search", () => {
	test("johan.zelf is taken when the pin is indexed only by tagName", async () => {
		IPFS.filter.mockImplementation(async (property, value) => {
			if (property === "tagName" && String(value).toLowerCase() === "johan.zelf") return [johanPin];
			return [];
		});

		const result = await searchZelfName({ zelfName: "johan.zelf" }, otherSession);

		expect(result.available).toBe(false);
		expect(result.ipfs).toHaveLength(1);
		expect(result.ipfs[0].zelfName).toBe("johan.zelf");
		expect(result.ipfs[0].publicData.tagName).toBe("johan.zelf");
		expect(result.ipfs[0].publicData.domain).toBe("zelf");
		expect(result.ipfs[0].publicData.ethAddress).toBe("0x0000000000000000000000000000000000000001");
		expect(IPFS.filter).toHaveBeenCalledWith("tagName", "johan.zelf", { throwOnError: true });
		expect(IPFS.filter).toHaveBeenCalledWith("zelfName", "johan.zelf", { throwOnError: true });
	});

	test("a Pinata file named johan.zelf.png is kept by the same name fallback tags uses", async () => {
		IPFS.filter.mockImplementation(async (property, value) => {
			if (property === "name" && String(value).toLowerCase() === "johan.zelf") return [johanPin];
			return [];
		});

		const result = await searchZelfName({ zelfName: "johan.zelf" }, otherSession);

		expect(result.available).toBe(false);
		expect(result.ipfs.map((row) => row.zelfName)).toEqual(["johan.zelf"]);
	});

	test("a failed name lookup is not reported as available", async () => {
		IPFS.filter.mockRejectedValue(new Error("pinata_unavailable"));

		const result = await searchZelfName({ zelfName: "johan.zelf" }, otherSession);

		expect(result.available).not.toBe(true);
		expect(result.ipfs).toEqual([]);
	});
});
