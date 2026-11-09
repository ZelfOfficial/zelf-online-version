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
const NATIVE_HASH = "0x" + "a".repeat(64);
const TOKEN_HASH = "0x" + "c".repeat(64);
const PAGE2_NATIVE_HASH = "0x" + "1".repeat(64);
const PAGE2_TOKEN_HASH = "0x" + "2".repeat(64);

const nativeItem = {
	hash: NATIVE_HASH,
	block: 100,
	timestamp: "2024-06-01T12:00:00.000000Z",
	from: { hash: TEST_ADDRESS },
	to: { hash: OTHER_ADDRESS },
	value: "1000000000000000000",
	fee: { value: "21000000000000" },
	raw_input: "0x",
	method: "transfer",
};

const tokenItem = {
	tx_hash: TOKEN_HASH,
	block_number: 200,
	timestamp: "2024-07-01T12:00:00.000000Z",
	from: { hash: OTHER_ADDRESS },
	to: { hash: TEST_ADDRESS },
	method: "transfer",
	token: { symbol: "USDC", decimals: "6", exchange_rate: "1", type: "ERC-20" },
	total: { decimals: "6", value: "2500000" },
};

const loadBaseModule = () => {
	let mod;
	jest.isolateModules(() => {
		mod = require("../../Repositories/base/modules/base-scrapping.module");
	});
	return mod;
};

const httpResult = (items, nextPageParams = null) => ({
	status: 200,
	data: { items, next_page_params: nextPageParams },
});

describe("Base Blockscout history", () => {
	beforeEach(() => {
		axios.get.mockReset();
		axios.post.mockReset();
	});

	it("uses Blockscout native and token transfers as the primary history", async () => {
		axios.get.mockImplementation(async (url) => {
			if (String(url).includes("/token-transfers")) {
				return httpResult([tokenItem], { block_number: 200, index: 3 });
			}
			if (String(url).includes("/transactions")) {
				return httpResult([nativeItem], { block_number: 100, index: 1, hash: NATIVE_HASH });
			}
			throw new Error(`unexpected url ${url}`);
		});

		const { getTransactionsList } = loadBaseModule();
		const result = await getTransactionsList({ address: TEST_ADDRESS, page: "0", show: "20" });

		expect(result.source).toBe("blockscout");
		expect(result.transactions.map((tx) => tx.hash)).toEqual([TOKEN_HASH, NATIVE_HASH]);
		expect(result.transactions[0]).toMatchObject({
			asset: "USDC",
			amount: "2.5",
			fiatAmount: "2.50",
			traffic: "IN",
			method: "transfer",
		});
		expect(result.transactions[0].date).toContain("2024-07-01");
		expect(result.transactions[1]).toMatchObject({
			asset: "ETH",
			amount: "1",
			fiatAmount: "2500.00",
			traffic: "OUT",
		});
		expect(result.pagination).toMatchObject({
			page: "1",
			nextPageParams: { block_number: 100, index: 1, hash: NATIVE_HASH },
			nextTokenPageParams: { block_number: 200, index: 3 },
		});
		expect(axios.get).not.toHaveBeenCalledWith(expect.stringContaining("oklink.com"), expect.anything());
		expect(axios.get.mock.calls.some(([url]) => String(url).includes("base.blockscout.com/api/v2/addresses/"))).toBe(true);
		const timeouts = axios.get.mock.calls.map(([, options]) => options.timeout);
		expect(timeouts.every((timeout) => timeout > 0 && timeout <= 7000)).toBe(true);
	});

	it("returns token transfers when native history is empty", async () => {
		axios.get.mockImplementation(async (url) => {
			if (String(url).includes("/token-transfers")) return httpResult([tokenItem]);
			if (String(url).includes("/transactions")) return httpResult([]);
			throw new Error(`unexpected url ${url}`);
		});

		const { getTransactionsList } = loadBaseModule();
		const result = await getTransactionsList({ address: TEST_ADDRESS, page: "1", show: "25" });

		expect(result.source).toBe("blockscout");
		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0].asset).toBe("USDC");
	});

	it("walks Blockscout pages and sends separate token cursors", async () => {
		axios.get.mockImplementation(async (url, options) => {
			const params = options?.params || {};
			if (String(url).includes("/token-transfers")) {
				expect(params).toMatchObject({ block_number: "90", index: "4" });
				return httpResult([{ ...tokenItem, tx_hash: PAGE2_TOKEN_HASH }], { block_number: 80, index: 1 });
			}
			if (String(url).includes("/transactions")) {
				if (!params.block_number) {
					return httpResult([nativeItem], { block_number: 10, index: 1 });
				}
				return httpResult([{ ...nativeItem, hash: PAGE2_NATIVE_HASH, timestamp: "2024-05-01T00:00:00.000000Z" }]);
			}
			throw new Error(`unexpected url ${url}`);
		});

		const { getTransactionsList } = loadBaseModule();
		const result = await getTransactionsList({
			address: TEST_ADDRESS,
			page: "2",
			show: "1",
			deadlineMs: 12000,
			token_block_number: "90",
			token_index: "4",
		});

		expect(result.transactions.map((tx) => tx.hash).sort()).toEqual([PAGE2_NATIVE_HASH, PAGE2_TOKEN_HASH].sort());
		expect(result.pagination.nextTokenPageParams).toEqual({ block_number: 80, index: 1 });
		const nativeCalls = axios.get.mock.calls.filter(([url]) => String(url).includes("/transactions"));
		expect(nativeCalls).toHaveLength(2);
		expect(nativeCalls[1][1].params).toMatchObject({ block_number: 10, index: 1 });
	});

	it("falls back to OKLink when Blockscout times out", async () => {
		axios.get.mockImplementation(async (url) => {
			if (String(url).includes("blockscout.com")) {
				const error = new Error("timeout of 7000ms exceeded");
				error.code = "ECONNABORTED";
				throw error;
			}
			if (String(url).includes("oklink.com")) {
				return {
					status: 200,
					data: {
						code: "0",
						data: {
							total: 1,
							hits: [
								{
									hash: "0x" + "b".repeat(64),
									blockHeight: 5,
									from: TEST_ADDRESS,
									to: OTHER_ADDRESS,
									value: "0.2",
									blocktime: 1700000000,
									method: "ETH transfer",
									status: "0x1",
									fee: "0.00001",
								},
							],
						},
					},
				};
			}
			return { status: 200, data: { status: "0", message: "NOTOK", result: [] } };
		});

		const { getTransactionsList } = loadBaseModule();
		const result = await getTransactionsList({ address: TEST_ADDRESS, page: "1", show: "10" });

		expect(result.source).toBe("oklink");
		expect(result.transactions[0]).toMatchObject({ asset: "ETH", fiatAmount: "500.00" });
	});

	it("returns a clean empty list when every source fails", async () => {
		axios.get.mockImplementation(async (url) => {
			if (String(url).includes("blockscout.com")) {
				const error = new Error("Request failed with status code 502");
				error.response = { status: 502 };
				throw error;
			}
			if (String(url).includes("oklink.com")) {
				return { status: 200, data: { code: "5005", msg: "API_DECODE_ERROR" } };
			}
			return { status: 200, data: { status: "0", message: "NOTOK", result: "Free API access is not supported for this chain" } };
		});

		const { getTransactionsList } = loadBaseModule();
		const result = await getTransactionsList({ address: TEST_ADDRESS, page: "1", show: "25" });

		expect(result.transactions).toEqual([]);
		expect(result.incomplete).toBeUndefined();
		expect(result.pagination).toMatchObject({ records: "0", pages: "0", page: "1" });
		expect(JSON.stringify(result)).not.toContain("0x0000000000000000000000000000000000000000000000000000000000000000");
	});

	it("keeps an incomplete marker when pagination exceeds the time budget and no other source has rows", async () => {
		axios.get.mockImplementation(async () => {
			const error = new Error("timeout of 7000ms exceeded");
			error.code = "ECONNABORTED";
			throw error;
		});

		const { getTransactionsList } = loadBaseModule();
		const result = await getTransactionsList({ address: TEST_ADDRESS, page: "4", show: "25", deadlineMs: 12000 });

		expect(result.source).toBe("blockscout");
		expect(result.transactions).toEqual([]);
		expect(result.incomplete).toBe(true);
		expect(result.hasMore).toBe(true);
		expect(result.pagination.pagingNote).toEqual(expect.any(String));
	});
});

describe("Base history error codes", () => {
	it("rejects an invalid transaction query with INVALID_BASE_TRANSACTION_QUERY", async () => {
		const ctx = { request: { params: { address: "not-an-address" }, query: { page: "1" } }, status: 200, body: null };
		await Middleware.validateAddressTransactions(ctx, async () => {
			throw new Error("next should not run");
		});

		expect(ctx.status).toBe(400);
		expect(ctx.body.code).toBe("INVALID_BASE_TRANSACTION_QUERY");
	});

	it("rejects an invalid address with INVALID_BASE_ADDRESS", async () => {
		const ctx = { request: { params: { address: "0x123" } }, status: 200, body: null };
		await Middleware.validateAddress(ctx, async () => {
			throw new Error("next should not run");
		});

		expect(ctx.status).toBe(400);
		expect(ctx.body.code).toBe("INVALID_BASE_ADDRESS");
	});

	it("allows Blockscout cursor query params", async () => {
		const ctx = {
			request: {
				params: { address: TEST_ADDRESS },
				query: { page: "2", show: "25", block_number: "10", index: "1", token_block_number: "9", token_index: "2" },
			},
			status: 200,
			body: null,
		};
		let continued = false;
		await Middleware.validateAddressTransactions(ctx, async () => {
			continued = true;
		});

		expect(continued).toBe(true);
	});
});
