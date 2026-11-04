/**
 * BSC balances fast path (/bsc/address/:id):
 * - curated common-tokens.json (contracts + decimals verified on BSC through Multicall3 symbol()/decimals())
 * - native BNB + all token balances in ONE Multicall3 eth_call, RPC fallbacks with short timeouts
 * - one cached price batch; last good price kept so a failed refresh can't zero a total (the $1,864 → $120 swing)
 * - transactions fetched in parallel and never allowed to block balances; response shape unchanged
 */
const { Interface, getAddress } = require("ethers");

const TOKENS_PATH = "../../Repositories/bnb/data/common-tokens.json";
const MULTICALL_PATH = "../../Repositories/bnb/modules/bsc-multicall.module";
const PRICES_PATH = "../../Repositories/bnb/modules/bsc-prices.module";
const RPC_PATH = "../../Repositories/bnb/modules/bsc-rpc.module";
const MODULE_PATH = "../../Repositories/bnb/modules/binance-smart-chain.module";
const AXIOS_PATH = "../../Core/axios";

// Verified on BSC mainnet (Multicall3 aggregate3 of symbol()/decimals(), 2026-10-17).
const VERIFIED_ON_BSC = {
	USDT: ["0x55d398326f99059fF775485246999027B3197955", 18],
	USDC: ["0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", 18],
	FDUSD: ["0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409", 18],
	USD1: ["0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d", 18],
	DAI: ["0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3", 18],
	BUSD: ["0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56", 18],
	WBNB: ["0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", 18],
	BTCB: ["0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", 18],
	ETH: ["0x2170Ed0880ac9A755fd29B2688956BD959F933F8", 18],
	Cake: ["0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", 18],
	XRP: ["0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE", 18],
	DOGE: ["0xbA2aE424d960c26247Dd6c32edC70B295c744C43", 8],
	ADA: ["0x3EE2200Efb3400fAbB9AacF31297cBdD1d435D47", 18],
	SOL: ["0x570A5D26f7765Ecb712C0924E4De545B89fD43dF", 18],
	LINK: ["0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD", 18],
	DOT: ["0x7083609fCE4d1d8Dc0C979AAb8c869Ea2C873402", 18],
	TRX: ["0xCE7de646e7208a4Ef112cb6ed5038FA6cC6b12e3", 6],
	UNI: ["0xBf5140A22578168FD562DCcF235E5D43A02ce9B1", 18],
	LTC: ["0x4338665CBB7B2485A8855A139b75D5e34AB0DB94", 18],
	AVAX: ["0x1CE0c2827e2eF14D5C4f29a091d735A204794041", 18],
	SHIB: ["0x2859e4544C4bB03966803b044A93563Bd2D0DD4D", 18],
	TWT: ["0x4B0F1812e5Df2A09796481Ff14017e6005508003", 18],
	XVS: ["0xcF6BB5389c92Bdda8a3747Ddb454cB7a64626C63", 18],
	FLOKI: ["0xfb5B838b6cfEEdC2873aB27866079AC55363D37E", 9],
	PEPE: ["0x25d887Ce7a35172C62FeBFD67a1856F20FaEbB00", 18],
	AAVE: ["0xfb6115445Bff7b52FeB98650C87f44907E58f802", 18],
};

const USER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fake axios instance factory: route(url, method, body) -> data | throws. */
const mockAxios = (route) => {
	const calls = [];
	const make = () => ({
		get: jest.fn(async (url) => {
			calls.push({ method: "GET", url });
			return { data: await route(url, "GET") };
		}),
		post: jest.fn(async (url, body) => {
			calls.push({ method: "POST", url, body });
			return { data: await route(url, "POST", body) };
		}),
	});
	jest.doMock(AXIOS_PATH, () => ({ getCleanInstance: () => make(), getDefaultInstance: () => make() }));
	return calls;
};

describe("BSC common-tokens.json", () => {
	const TOKENS = require(TOKENS_PATH);

	it("lists every contract once, checksummed", () => {
		const addrs = TOKENS.map((t) => t.contractAddress.toLowerCase());
		expect(new Set(addrs).size).toBe(addrs.length);
		for (const t of TOKENS) expect(getAddress(t.contractAddress)).toBe(t.contractAddress);
	});

	it("only lists contracts verified on BSC with the on-chain decimals", () => {
		expect(TOKENS.map((t) => t.symbol).sort()).toEqual(Object.keys(VERIFIED_ON_BSC).sort());
		for (const t of TOKENS) {
			const [addr, decimals] = VERIFIED_ON_BSC[t.symbol];
			expect(t.contractAddress).toBe(addr);
			expect(t.decimals).toBe(decimals);
		}
	});

	it("gives every token a price source (Binance pair, CoinGecko id or stablecoin peg)", () => {
		for (const t of TOKENS) expect(Boolean(t.priceSymbol || t.coingeckoId || t.stable)).toBe(true);
		const symbols = TOKENS.map((t) => t.symbol);
		for (const dropped of ["POSI", "MATIC"]) expect(symbols).not.toContain(dropped);
	});
});

describe("Multicall3 encode/decode", () => {
	const m3 = new Interface([
		"function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
		"function getEthBalance(address addr) view returns (uint256 balance)",
	]);
	const erc20 = new Interface(["function balanceOf(address owner) view returns (uint256)"]);
	const tokens = [{ contractAddress: VERIFIED_ON_BSC.USDT[0] }, { contractAddress: VERIFIED_ON_BSC.DOGE[0] }, { contractAddress: VERIFIED_ON_BSC.ETH[0] }];

	beforeEach(() => jest.resetModules());

	it("packs native BNB + one balanceOf per token into a single aggregate3 call", () => {
		const { encodeBalancesCall, MULTICALL3_ADDRESS } = require(MULTICALL_PATH);
		const [calls] = m3.decodeFunctionData("aggregate3", encodeBalancesCall(USER, tokens));
		expect(calls).toHaveLength(4);
		expect(calls[0].target).toBe(MULTICALL3_ADDRESS);
		expect(m3.decodeFunctionData("getEthBalance", calls[0].callData)[0]).toBe(USER);
		calls.slice(1).forEach((c, i) => {
			expect(c.target).toBe(tokens[i].contractAddress);
			expect(c.allowFailure).toBe(true);
			expect(erc20.decodeFunctionData("balanceOf", c.callData)[0]).toBe(USER);
		});
	});

	it("decodes balances and skips failed sub-calls", () => {
		const { decodeBalancesResult } = require(MULTICALL_PATH);
		const enc = (iface, fn, v) => iface.encodeFunctionResult(fn, [v]);
		const ret = m3.encodeFunctionResult("aggregate3", [
			[
				[true, enc(m3, "getEthBalance", 5n * 10n ** 17n)],
				[true, enc(erc20, "balanceOf", 1234n * 10n ** 18n)],
				[false, "0x"],
				[true, enc(erc20, "balanceOf", 0n)],
			],
		]);
		const { nativeWei, tokenBalances } = decodeBalancesResult(ret, tokens);
		expect(nativeWei).toBe(5n * 10n ** 17n);
		expect(tokenBalances.get(VERIFIED_ON_BSC.USDT[0].toLowerCase())).toBe(1234n * 10n ** 18n);
		expect(tokenBalances.has(VERIFIED_ON_BSC.DOGE[0].toLowerCase())).toBe(false);
		expect(tokenBalances.get(VERIFIED_ON_BSC.ETH[0].toLowerCase())).toBe(0n);
	});
});

describe("BSC RPC fallbacks", () => {
	beforeEach(() => {
		jest.resetModules();
		process.env.BSC_RPC_URL = "https://primary.example/secret-key-path";
		process.env.BSC_FALLBACK_RPC_URLS = "https://fallback-a.example,https://fallback-b.example";
	});
	afterEach(() => {
		delete process.env.BSC_RPC_URL;
		delete process.env.BSC_FALLBACK_RPC_URLS;
	});

	it("tries the primary, then each fallback, and returns the first good result", async () => {
		const calls = mockAxios(async (url) => {
			if (url.includes("primary")) throw Object.assign(new Error("timeout"), { code: "ECONNABORTED" });
			if (url.includes("fallback-a")) return { jsonrpc: "2.0", id: 1, error: { message: "limit exceeded" } };
			return { jsonrpc: "2.0", id: 1, result: "0x1" };
		});
		const { rpcCall } = require(RPC_PATH);
		await expect(rpcCall("eth_blockNumber", [])).resolves.toEqual({ result: "0x1", rpc: "fallback-b.example" });
		expect(calls.map((c) => new URL(c.url).host)).toEqual(["primary.example", "fallback-a.example", "fallback-b.example"]);
	});

	it("throws 503 when every endpoint fails, without leaking URL paths (provider keys)", async () => {
		mockAxios(async () => {
			throw new Error("down");
		});
		const { rpcCall } = require(RPC_PATH);
		const err = await rpcCall("eth_call", []).catch((e) => e);
		expect(err.status).toBe(503);
		expect(err.message).not.toContain("secret-key-path");
	});
});

describe("BSC prices: one batched, cached request", () => {
	const TOKENS = require(TOKENS_PATH);
	const NATIVE = { symbol: "BNB", priceSymbol: "BNB", coingeckoId: "binancecoin" };
	const tickers = [
		{ symbol: "BNBUSDT", price: "700" },
		{ symbol: "ETHUSDT", price: "2400" },
		{ symbol: "BTCUSDT", price: "80000" },
		{ symbol: "CAKEUSDT", price: "2" },
		{ symbol: "USDCUSDT", price: "1.0005" },
		{ symbol: "DAIUSDT", price: "0.5" }, // insane stable quote → peg
	];

	beforeEach(() => {
		jest.resetModules();
		delete process.env.BSC_PRICE_TTL_MS;
	});

	it("prices every token from one ticker request + one CoinGecko request, then serves from cache", async () => {
		const calls = mockAxios(async (url) => (url.includes("binance.us") ? tickers : url.includes("coingecko") ? { venus: { usd: 3 } } : null));
		const { getPrices, priceForToken } = require(PRICES_PATH);
		const all = [NATIVE, ...TOKENS];
		const [p1] = await Promise.all([getPrices(all), getPrices(all), getPrices([NATIVE])]);
		const by = (sym) => priceForToken(TOKENS.find((t) => t.symbol === sym), p1);
		expect(priceForToken(NATIVE, p1)).toBe(700);
		expect(by("WBNB")).toBe(700);
		expect(by("ETH")).toBe(2400);
		expect(by("BTCB")).toBe(80000);
		expect(by("Cake")).toBe(2);
		expect(by("XVS")).toBe(3);
		expect(by("USDT")).toBe(1);
		expect(by("USDC")).toBe(1.0005);
		expect(by("DAI")).toBe(1);
		await getPrices(all);
		expect(calls.filter((c) => c.url.includes("binance")).length).toBe(1);
		expect(calls.filter((c) => c.url.includes("coingecko")).length).toBe(1);
	});

	it("keeps the last good price when a refresh fails (no swing to 0)", async () => {
		process.env.BSC_PRICE_TTL_MS = "0";
		let fail = false;
		mockAxios(async (url) => {
			if (fail) throw Object.assign(new Error("429"), { response: { status: 429 } });
			return url.includes("binance.us") ? tickers : {};
		});
		const { getPrices, priceForToken } = require(PRICES_PATH);
		const eth = TOKENS.find((t) => t.symbol === "ETH");
		expect(priceForToken(eth, await getPrices([NATIVE, eth]))).toBe(2400);
		fail = true;
		await sleep(5);
		const again = await getPrices([NATIVE, eth]);
		expect(priceForToken(eth, again)).toBe(2400);
		expect(priceForToken(NATIVE, again)).toBe(700);
	});

	it("falls back to Binance.com when Binance.US is down", async () => {
		mockAxios(async (url) => {
			if (url.includes("binance.us")) throw new Error("down");
			if (url.includes("binance.com")) return [{ symbol: "BNBUSDT", price: "701" }];
			return {};
		});
		const { getPrices, priceForToken } = require(PRICES_PATH);
		expect(priceForToken(NATIVE, await getPrices([NATIVE]))).toBe(701);
	});
});

describe("GET /bsc/address/:id fast path", () => {
	const TOKENS = require(TOKENS_PATH);
	const tok = (sym) => TOKENS.find((t) => t.symbol === sym);

	const load = ({ rpcDelay = 50, txDelay = 10, txList = [], rpcFails = false } = {}) => {
		jest.resetModules();
		process.env.BSC_TX_GRACE_MS = "300";
		const calls = mockAxios(async (url) => {
			if (url.includes("oklink")) {
				await sleep(txDelay);
				return { code: "0", data: { hits: txList } };
			}
			if (url.includes("nodereal")) return { data: "0x0" };
			return {};
		});
		const getBalancesInSingleCall = jest.fn(async () => {
			await sleep(rpcDelay);
			if (rpcFails) throw Object.assign(new Error("bsc_rpc_unavailable"), { status: 503 });
			return {
				nativeWei: 2n * 10n ** 18n,
				tokenBalances: new Map([
					[tok("USDT").contractAddress.toLowerCase(), 100n * 10n ** 18n],
					[tok("ETH").contractAddress.toLowerCase(), 10n ** 18n],
					[tok("DOGE").contractAddress.toLowerCase(), 5n * 10n ** 8n],
					[tok("Cake").contractAddress.toLowerCase(), 0n],
				]),
				rpc: "mock",
			};
		});
		jest.doMock(MULTICALL_PATH, () => ({ getBalancesInSingleCall }));
		const prices = new Map([
			["S:BNB", 700],
			["S:ETH", 2400],
			["S:DOGE", 0.1],
		]);
		jest.doMock(PRICES_PATH, () => ({
			getPrices: jest.fn(async () => prices),
			priceForToken: (t, p) => (t.stable ? 1 : p.get(`S:${t.priceSymbol}`) || 0),
		}));
		return { Module: require(MODULE_PATH), getBalancesInSingleCall, calls };
	};

	afterEach(() => delete process.env.BSC_TX_GRACE_MS);

	it("keeps the response shape the extension reads", async () => {
		const { Module } = load();
		const d = await Module.getBalance({ id: USER });
		expect(Object.keys(d).sort()).toEqual(["account", "address", "balance", "fiatBalance", "tokenHoldings", "transactions"]);
		expect(d.address).toBe(USER);
		expect(d.balance).toBe(2);
		expect(d.fiatBalance).toBe(1400);
		expect(d.account).toEqual({ asset: "BNB", fiatBalance: "1400", price: 700 });
		const syms = d.tokenHoldings.tokens.map((t) => t.symbol);
		expect(syms).toEqual(["ETH", "USDT", "DOGE", "BNB"]); // sorted by fiat, zero balances dropped, BNB last
		expect(d.tokenHoldings.total).toBe(4);
		expect(d.tokenHoldings.balance).toBe(2400 + 100 + 0.5);
		const eth = d.tokenHoldings.tokens[0];
		expect(Object.keys(eth).sort()).toEqual(["_amount", "_fiatBalance", "_price", "address", "amount", "decimals", "fiatBalance", "image", "name", "price", "symbol", "tokenType"]);
		expect(eth).toMatchObject({ _amount: 1, _fiatBalance: "2400.0000000", _price: 2400, address: tok("ETH").contractAddress.toLowerCase(), amount: "1.000000000000", decimals: 18, fiatBalance: 2400, price: "2400.000000", tokenType: "BEP-20" });
		expect(d.tokenHoldings.tokens[2]).toMatchObject({ symbol: "DOGE", decimals: 8, _amount: 5, fiatBalance: 0.5 });
		expect(d.tokenHoldings.tokens[3]).toMatchObject({ symbol: "BNB", tokenType: "BNB", name: "Binance", amount: "2", price: 700, fiatBalance: 1400 });
		expect(Array.isArray(d.transactions)).toBe(true);
	});

	it("does all balances with ONE multicall and answers fast (timing)", async () => {
		const { Module, getBalancesInSingleCall } = load({ rpcDelay: 120 });
		const t = Date.now();
		await Module.getBalance({ id: USER });
		const ms = Date.now() - t;
		expect(getBalancesInSingleCall).toHaveBeenCalledTimes(1);
		expect(ms).toBeLessThan(600);
	});

	it("never lets slow history block balances (returns within the grace window, cache fills afterwards)", async () => {
		const hit = { hash: "0xabc", from: USER, to: "0x1", value: "1", blocktime: 1760000000, blockHeight: 1 };
		const { Module } = load({ rpcDelay: 20, txDelay: 2000, txList: [hit] });
		const t = Date.now();
		const d = await Module.getBalance({ id: USER });
		expect(Date.now() - t).toBeLessThan(800);
		expect(d.transactions).toEqual([]);
		await sleep(2100); // let the background history fetch finish (no dangling timers between tests)
	});

	it("includes history when it is ready in time", async () => {
		const hit = { hash: "0xabc", from: USER, to: "0x1", value: "1", blocktime: 1760000000, blockHeight: 1 };
		const { Module } = load({ rpcDelay: 50, txDelay: 10, txList: [hit] });
		const d = await Module.getBalance({ id: USER });
		expect(d.transactions).toHaveLength(1);
		expect(d.transactions[0]).toMatchObject({ hash: "0xabc", asset: "BNB", traffic: "OUT" });
	});

	it("shares one computation for concurrent calls and caches briefly (Home + Wallet)", async () => {
		const { Module, getBalancesInSingleCall } = load();
		await Promise.all([Module.getBalance({ id: USER }), Module.getBalance({ id: USER.toLowerCase() })]);
		await Module.getBalance({ id: USER });
		expect(getBalancesInSingleCall).toHaveBeenCalledTimes(1);
	});
});

describe("BSC address param validation (Joi in middleware)", () => {
	const Middleware = require("../../Repositories/bnb/middlewares/binance-smart-chain.middleware");
	const run = async (id) => {
		const ctx = { request: { params: { id }, query: {} } };
		const next = jest.fn();
		await Middleware.validateAddressParam(ctx, next);
		return { ctx, next };
	};

	it("accepts a 0x address", async () => {
		const { next, ctx } = await run(USER);
		expect(next).toHaveBeenCalled();
		expect(ctx.status).toBeUndefined();
	});

	it.each(["abc", "0x123", "d8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA9604Z"])("rejects %s with 409", async (id) => {
		const { next, ctx } = await run(id);
		expect(next).not.toHaveBeenCalled();
		expect(ctx.status).toBe(409);
	});
});
