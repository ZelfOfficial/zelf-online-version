/**
 * Base common-token list + Optimism/Arbitrum/Base native ETH pricing.
 * - common-tokens.json must hold only real Base contracts (verified on Base RPC: symbol()/decimals()).
 * - getAddress used getTickerPrice without importing it, so native ETH always priced at 0.
 */
const BASE_TOKENS = require("../../Repositories/base/data/common-tokens.json");

const VERIFIED_ON_BASE = {
	USDC: ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 6],
	USDT: ["0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", 6],
	DAI: ["0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", 18],
	WETH: ["0x4200000000000000000000000000000000000006", 18],
	cbETH: ["0x2Ae3F1Ec7F1F5012CFEab0185BfC7aa3CF0DEC22", 18],
	cbBTC: ["0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", 8],
	AERO: ["0x940181a94A35A4569E4529A3CDfB74e38FD98631", 18],
	BALD: ["0x27D2DECb4bFC9C76F0309b8E88dec3a601Fe25a8", 18],
	DEGEN: ["0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", 18],
};

describe("Base common-tokens.json", () => {
	it("lists every contract once (USDT/DAI and BNB/MATIC/WETH used to share contracts)", () => {
		const addrs = BASE_TOKENS.map((t) => t.contractAddress.toLowerCase());
		expect(new Set(addrs).size).toBe(addrs.length);
	});

	it("only lists contracts verified on Base with the right decimals", () => {
		for (const t of BASE_TOKENS) {
			expect(VERIFIED_ON_BASE[t.symbol]).toBeDefined();
			const [addr, decimals] = VERIFIED_ON_BASE[t.symbol];
			expect(t.contractAddress.toLowerCase()).toBe(addr.toLowerCase());
			expect(t.decimals).toBe(decimals);
		}
	});

	it("no longer lists the mislabeled entries", () => {
		const symbols = BASE_TOKENS.map((t) => t.symbol);
		for (const bad of ["BNB", "MATIC", "ARB", "OP", "PEPE", "SHIB", "DOGE", "MULTI"]) expect(symbols).not.toContain(bad);
	});
});

describe("Base token pricing symbol mapping", () => {
	beforeEach(() => jest.resetModules());

	it("prices WETH/cbETH as ETH and cbBTC as BTC, stablecoins at 1", async () => {
		const getTickerPrice = jest.fn(async ({ symbol }) => ({ price: symbol === "ETH" ? "2400" : symbol === "BTC" ? "60000" : "0" }));
		jest.doMock("../../Repositories/binance/modules/binance.module", () => ({ getTickerPrice }));
		const { getTokenPrice } = require("../../Repositories/base/utils/token-pricing");

		expect(await getTokenPrice("WETH")).toBe("2400");
		expect(await getTokenPrice("cbETH")).toBe("2400");
		expect(await getTokenPrice("cbBTC")).toBe("60000");
		expect(await getTokenPrice("USDT")).toBe("1.00");
	});
});

describe.each([
	["base", "../../Repositories/base/modules/base-scrapping.module"],
	["optimism", "../../Repositories/optimism/modules/optimism-scrapping.module"],
	["arbitrum", "../../Repositories/arbitrum/modules/arbitrum-scrapping.module"],
])("%s getAddress native ETH price", (_chain, modulePath) => {
	beforeEach(() => jest.resetModules());

	it("prices native ETH with getTickerPrice instead of 0", async () => {
		const getTickerPrice = jest.fn(async () => ({ price: "2400" }));
		jest.doMock("../../Repositories/binance/modules/binance.module", () => ({ getTickerPrice }));
		jest.doMock("../../Repositories/Solana/modules/oklink", () => ({ get_ApiKey: () => ({ getApiKey: () => "test" }) }));
		jest.doMock("axios", () => {
			const instance = {
				// 1 ETH balance; every token balanceOf returns 0
				post: jest.fn(async (_url, body) => ({ data: { result: body.method === "eth_getBalance" ? "0xde0b6b3a7640000" : "0x0" } })),
				get: jest.fn(async () => {
					throw new Error("offline");
				}),
			};
			const axios = { create: () => instance, get: instance.get, post: instance.post };
			axios.default = axios;
			return axios;
		});

		const { getAddress } = require(modulePath);
		const out = await getAddress({ address: "0x000000000000000000000000000000000000dEaD" });
		const data = out.data || out;
		const eth = data.tokenHoldings.tokens.find((t) => t.symbol === "ETH");

		expect(getTickerPrice).toHaveBeenCalledWith({ symbol: "ETH" });
		expect(parseFloat(eth.price)).toBe(2400);
		expect(parseFloat(eth.fiatBalance)).toBeCloseTo(2400, 2);
	}, 20000);
});
