jest.mock("axios", () => {
	const get = jest.fn();
	const post = jest.fn();
	return {
		get,
		post,
		create: jest.fn(() => ({ get, post })),
	};
});

jest.mock("../../Repositories/binance/modules/binance.module", () => ({
	getTickerPrice: jest.fn(async () => ({ price: "2500" })),
}));

jest.mock("../../Repositories/Solana/modules/oklink", () => ({
	get_ApiKey: () => ({ getApiKey: () => "test-oklink-key" }),
}));

const axios = require("axios");
const Middleware = require("../../Repositories/base/middlewares/base-scrapping.middleware");

const TEST_ADDRESS = "0x75F766ae57E08C9470CCe2AC30dD2b6B009Fccde";
const OTHER_ADDRESS = "0x1111111111111111111111111111111111111111";
const ALCHEMY_URL = "https://alchemy.test/base";
const ETH_HASH = "0x" + "a".repeat(64);
const USDC_HASH = "0x" + "c".repeat(64);
const INTERNAL_HASH = "0x" + "b".repeat(64);
const DUP_HASH = "0x" + "e".repeat(64);
const SPAM_HASH = "0x" + "d".repeat(64);
const ZERO_WIDTH_HASH = "0x" + "f".repeat(64);
const BLOCKSCOUT_HASH = "0x" + "1".repeat(64);

const loadBaseModule = (baseUrl) => {
	let mod;
	jest.isolateModules(() => {
		const config = require("../../Core/config");
		config.alchemy.networks.base = baseUrl;
		mod = require("../../Repositories/base/modules/base-scrapping.module");
	});
	return mod;
};

const rpcResult = (result) => ({ data: { jsonrpc: "2.0", id: 1, result } });

const transfer = ({ uniqueId, hash, from, to, asset, category, rawValue, decimal, timestamp, blockNum, floatValue }) => ({
	uniqueId,
	hash,
	blockNum: blockNum || "0x64",
	from,
	to,
	value: floatValue,
	asset,
	category,
	rawContract: {
		value: rawValue,
		address: category === "erc20" ? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" : null,
		decimal,
	},
	metadata: { blockTimestamp: timestamp },
});

const historyPages = () => ({
	outgoing: {
		pageKey: "from-next",
		transfers: [
			transfer({
				uniqueId: "eth-1",
				hash: ETH_HASH,
				from: TEST_ADDRESS,
				to: OTHER_ADDRESS,
				asset: "ETH",
				category: "external",
				rawValue: "0xde0b6b3a7640000",
				decimal: "0x12",
				timestamp: "2024-06-01T12:00:00.000Z",
				floatValue: 99,
			}),
			transfer({
				uniqueId: "internal-1",
				hash: INTERNAL_HASH,
				from: TEST_ADDRESS,
				to: OTHER_ADDRESS,
				asset: "ETH",
				category: "internal",
				rawValue: "0x2386f26fc10000",
				decimal: "0x12",
				timestamp: "2024-07-01T00:00:00.000Z",
				blockNum: "0x65",
				floatValue: 1,
			}),
			transfer({
				uniqueId: "dup-1",
				hash: DUP_HASH,
				from: TEST_ADDRESS,
				to: OTHER_ADDRESS,
				asset: "ETH",
				category: "external",
				rawValue: "0x2c68af0bb140000",
				decimal: "0x12",
				timestamp: "2024-05-01T00:00:00.000Z",
				floatValue: 0,
			}),
			transfer({
				uniqueId: "spam-cyrillic",
				hash: SPAM_HASH,
				from: OTHER_ADDRESS,
				to: TEST_ADDRESS,
				asset: "\u0415TH",
				category: "erc20",
				rawValue: "0x1",
				decimal: "0x12",
				timestamp: "2024-09-01T00:00:00.000Z",
				floatValue: 1,
			}),
		],
	},
	incoming: {
		pageKey: "to-next",
		transfers: [
			transfer({
				uniqueId: "usdc-1",
				hash: USDC_HASH,
				from: OTHER_ADDRESS,
				to: TEST_ADDRESS,
				asset: "USDC",
				category: "erc20",
				rawValue: "0xf4241",
				decimal: "0x6",
				timestamp: "2024-08-01T00:00:00.000Z",
				floatValue: 1.5,
			}),
			transfer({
				uniqueId: "dup-1",
				hash: DUP_HASH,
				from: TEST_ADDRESS,
				to: OTHER_ADDRESS,
				asset: "ETH",
				category: "external",
				rawValue: "0x2c68af0bb140000",
				decimal: "0x12",
				timestamp: "2024-05-01T00:00:00.000Z",
				floatValue: 9,
			}),
			transfer({
				uniqueId: "spam-zwsp",
				hash: ZERO_WIDTH_HASH,
				from: OTHER_ADDRESS,
				to: TEST_ADDRESS,
				asset: "ET\u200bH",
				category: "erc20",
				rawValue: "0x1",
				decimal: "0x12",
				timestamp: "2024-09-02T00:00:00.000Z",
				floatValue: 1,
			}),
		],
	},
});

const mockAlchemy = (pages) => {
	axios.post.mockImplementation(async (_url, body) => {
		const params = body?.params?.[0] || {};
		if (body?.method !== "alchemy_getAssetTransfers") return rpcResult(null);
		if (params.fromAddress) return rpcResult(pages.outgoing);
		if (params.toAddress) return rpcResult(pages.incoming);
		return rpcResult({ transfers: [] });
	});
};

const blockscoutPayload = (items) => ({
	status: 200,
	data: { items, next_page_params: null },
});

const mockBlockscoutNative = () => {
	axios.get.mockImplementation(async (url) => {
		if (String(url).includes("/token-transfers")) return blockscoutPayload([]);
		if (String(url).includes("/transactions")) {
			return blockscoutPayload([
				{
					hash: BLOCKSCOUT_HASH,
					block: 10,
					timestamp: "2024-01-01T00:00:00.000000Z",
					from: { hash: TEST_ADDRESS },
					to: { hash: OTHER_ADDRESS },
					value: "1000000000000000000",
					fee: { value: "1" },
					raw_input: "0x",
					method: "transfer",
				},
			]);
		}
		return blockscoutPayload([]);
	});
};

describe("Base Alchemy history", () => {
	beforeEach(() => {
		axios.get.mockReset();
		axios.post.mockReset();
		axios.get.mockResolvedValue({ status: 200, data: { items: [], next_page_params: null } });
	});

	it("merges both directions, dedupes by uniqueId, and keeps exact decimals", async () => {
		mockAlchemy(historyPages());
		const { getTransactionsList } = loadBaseModule(ALCHEMY_URL);

		const result = await getTransactionsList({ address: TEST_ADDRESS, page: "0", show: "20" });

		expect(result.source).toBe("alchemy");
		expect(result.transactions.map((tx) => tx.hash)).toEqual([USDC_HASH, INTERNAL_HASH, ETH_HASH, DUP_HASH]);
		expect(result.transactions.filter((tx) => tx.hash === DUP_HASH)).toHaveLength(1);
		expect(result.transactions.map((tx) => tx.hash)).not.toContain(SPAM_HASH);
		expect(result.transactions.map((tx) => tx.hash)).not.toContain(ZERO_WIDTH_HASH);
		expect(result.transactions[0]).toMatchObject({
			asset: "USDC",
			amount: "1.000001",
			fiatAmount: "0.00",
			traffic: "IN",
			txnFee: "0",
			block: "100",
		});
		expect(result.transactions[0].date).toContain("2024-08-01");
		expect(result.transactions[1]).toMatchObject({
			asset: "ETH",
			amount: "0.01",
			fiatAmount: "25.00",
			traffic: "OUT",
			block: "101",
			txnFee: "0",
		});
		expect(result.transactions[2]).toMatchObject({
			asset: "ETH",
			amount: "1",
			fiatAmount: "2500.00",
			traffic: "OUT",
			txnFee: "0",
		});
		expect(result.transactions[3]).toMatchObject({ amount: "0.2", asset: "ETH" });
		expect(result.pagination).toMatchObject({
			page: "1",
			nextPageParams: { fromPageKey: "from-next", toPageKey: "to-next" },
		});
		expect(axios.get).not.toHaveBeenCalled();
		expect(axios.post).toHaveBeenCalledTimes(2);

		const bodies = axios.post.mock.calls.map((call) => call[1]);
		expect(bodies.map((body) => body.method)).toEqual(["alchemy_getAssetTransfers", "alchemy_getAssetTransfers"]);
		expect(bodies.map((body) => body.params[0].category)).toEqual([
			["external", "internal", "erc20"],
			["external", "internal", "erc20"],
		]);
		expect(bodies.every((body) => body.params[0].order === "desc" && body.params[0].withMetadata === true)).toBe(true);
		expect(bodies.map((body) => body.params[0].maxCount)).toEqual(["0x14", "0x14"]);
		expect(bodies.map((body) => body.params[0].fromAddress).filter(Boolean)).toEqual([TEST_ADDRESS]);
		expect(bodies.map((body) => body.params[0].toAddress).filter(Boolean)).toEqual([TEST_ADDRESS]);
		expect(axios.post.mock.calls.every(([url]) => url === ALCHEMY_URL)).toBe(true);
		expect(axios.post.mock.calls.every(([url]) => !String(url).includes("/v2/"))).toBe(true);
		expect(axios.post.mock.calls.every((call) => call[2].timeout > 0 && call[2].timeout <= 7000)).toBe(true);
	});

	it("sends fromPageKey and toPageKey back and caps maxCount", async () => {
		mockAlchemy(historyPages());
		const { getTransactionsList } = loadBaseModule(ALCHEMY_URL);

		await getTransactionsList({
			address: TEST_ADDRESS,
			page: "2",
			show: "20",
			fromPageKey: "from-next",
			toPageKey: "to-next",
		});

		const params = axios.post.mock.calls.map((call) => call[1].params[0]);
		expect(params).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ fromAddress: TEST_ADDRESS, pageKey: "from-next", maxCount: "0x14" }),
				expect.objectContaining({ toAddress: TEST_ADDRESS, pageKey: "to-next", maxCount: "0x14" }),
			])
		);

		axios.post.mockClear();
		await getTransactionsList({ address: TEST_ADDRESS, page: "1", show: "5000" });
		expect(axios.post.mock.calls.map((call) => call[1].params[0].maxCount)).toEqual(["0x64", "0x64"]);
	});

	it("falls through to Blockscout when Alchemy is not configured", async () => {
		mockBlockscoutNative();
		const { getTransactionsList } = loadBaseModule(null);
		const result = await getTransactionsList({ address: TEST_ADDRESS, page: "1", show: "10" });

		expect(result.source).toBe("blockscout");
		expect(result.transactions.map((tx) => tx.hash)).toContain(BLOCKSCOUT_HASH);
		expect(axios.post).not.toHaveBeenCalled();
	});

	it("falls through when Alchemy times out without logging the endpoint", async () => {
		const logs = [];
		const spy = jest.spyOn(console, "log").mockImplementation((message) => {
			logs.push(String(message));
		});
		axios.post.mockRejectedValue(Object.assign(new Error("timeout of 7000ms exceeded"), { code: "ECONNABORTED" }));
		mockBlockscoutNative();

		try {
			const { getTransactionsList } = loadBaseModule(ALCHEMY_URL);
			const result = await getTransactionsList({ address: TEST_ADDRESS, page: "1", show: "10" });

			expect(result.source).toBe("blockscout");
			expect(result.transactions.map((tx) => tx.hash)).toContain(BLOCKSCOUT_HASH);
			expect(logs.join("\n")).toContain("ALCHEMY_TRANSFERS_FAILED");
			expect(logs.join("\n")).not.toContain(ALCHEMY_URL);
			expect(logs.join("\n")).not.toContain("/v2/");
		} finally {
			spy.mockRestore();
		}
	});

	it("drops a page of only spam symbols and uses the next provider", async () => {
		mockAlchemy({
			outgoing: {
				transfers: [
					transfer({
						uniqueId: "spam-only",
						hash: SPAM_HASH,
						from: OTHER_ADDRESS,
						to: TEST_ADDRESS,
						asset: "ETH\uFEFF",
						category: "erc20",
						rawValue: "0x1",
						decimal: "0x12",
						timestamp: "2024-09-01T00:00:00.000Z",
						floatValue: 5,
					}),
				],
			},
			incoming: { transfers: [] },
		});
		mockBlockscoutNative();

		const { getTransactionsList } = loadBaseModule(ALCHEMY_URL);
		const result = await getTransactionsList({ address: TEST_ADDRESS, page: "1", show: "10" });

		expect(result.source).toBe("blockscout");
		expect(result.transactions.map((tx) => tx.hash)).not.toContain(SPAM_HASH);
	});
});

describe("Base history pagination query", () => {
	it("accepts Alchemy page keys already allowed by the schema", async () => {
		const ctx = {
			request: {
				params: { address: TEST_ADDRESS },
				query: { page: "2", show: "20", fromPageKey: "from-next", toPageKey: "to-next" },
			},
			status: 200,
			body: null,
		};
		let continued = false;
		await Middleware.validateAddressTransactions(ctx, async () => {
			continued = true;
		});

		expect(continued).toBe(true);
		expect(ctx.status).toBe(200);
	});
});
