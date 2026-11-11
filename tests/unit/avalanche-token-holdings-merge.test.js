const { mergeAvalancheTokenHoldings } = require("../../Repositories/Avalanche/modules/avalanche-balance.util");

const USDC = "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E";
const WAVAX = "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7";

const token = (overrides) => ({
	_amount: 1,
	_fiatBalance: "0",
	_price: 0,
	address: USDC,
	amount: "1",
	decimals: 18,
	fiatBalance: 0,
	image: "",
	name: "Token",
	price: "0",
	symbol: "TKN",
	tokenType: "ERC-20",
	...overrides,
});

describe("mergeAvalancheTokenHoldings", () => {
	it("dedupes by lowercase contract address and keeps the priced entry", () => {
		const unpriced = token({
			address: USDC,
			name: "USD Coin",
			symbol: "USDC",
			fiatBalance: 0,
			price: "0",
			_price: 0,
			_fiatBalance: "0",
			image: "",
		});
		const priced = token({
			address: USDC.toLowerCase(),
			name: "USD Coin Glacier",
			symbol: "USDC",
			fiatBalance: 4,
			price: "1",
			_price: 1,
			_fiatBalance: "4",
			image: "https://cdn.example/usdc.png",
		});
		const joe = token({
			address: "0x6e84a6216eA6dACC71eE8E6b0a5B7322EEbC0fDd",
			name: "JoeToken",
			symbol: "JOE",
			fiatBalance: 20,
			price: "5",
			_price: 5,
			_fiatBalance: "20",
			image: "https://cdn.example/joe.png",
		});

		const merged = mergeAvalancheTokenHoldings({ tokens: [unpriced] }, { tokens: [priced, joe] });

		expect(Object.keys(merged)).toEqual(["balance", "total", "tokens"]);
		expect(merged.total).toBe(2);
		expect(merged.balance).toBe("24");
		expect(merged.tokens.map((entry) => entry.symbol)).toEqual(["USDC", "JOE"]);
		expect(merged.tokens[0]).toMatchObject({
			name: "USD Coin Glacier",
			address: USDC.toLowerCase(),
			_fiatBalance: "4",
			_price: 1,
			image: "https://cdn.example/usdc.png",
		});
		expect(merged.tokens[1]).toMatchObject({
			_fiatBalance: "20",
			_price: 5,
			image: "https://cdn.example/joe.png",
		});
	});

	it("does not double fiat when both copies already have a price", () => {
		const routescan = token({
			address: USDC,
			name: "USD Coin",
			symbol: "USDC",
			fiatBalance: 2,
			price: "1",
			_price: 1,
			_fiatBalance: "2",
			image: "",
		});
		const glacier = token({
			address: USDC.toLowerCase(),
			name: "USD Coin Glacier",
			symbol: "USDC",
			fiatBalance: 9,
			price: "1",
			_price: 1,
			_fiatBalance: "9",
			image: "https://cdn.example/usdc.png",
		});

		const merged = mergeAvalancheTokenHoldings({ tokens: [routescan] }, { tokens: [glacier] });

		expect(merged.total).toBe(1);
		expect(merged.balance).toBe("2");
		expect(merged.tokens[0]).toMatchObject({
			name: "USD Coin",
			_fiatBalance: "2",
			_price: 1,
			image: "",
		});
	});

	it("keeps a single native AVAX entry and does not collapse a contract that uses the AVAX symbol", () => {
		const plainNative = {
			amount: "1",
			fiatBalance: 0,
			name: "Plain",
			price: "0",
			symbol: "AVAX",
			tokenType: "AVAX",
		};
		const pricedNative = {
			_fiatBalance: "20",
			_price: 20,
			amount: "1",
			fiatBalance: 20,
			image: "https://cdn.zelf.world/icons/ic_avax.png",
			name: "Priced AVAX",
			price: "20",
			symbol: "AVAX",
			tokenType: "AVAX",
		};
		const wrapped = token({
			address: WAVAX,
			name: "Wrapped AVAX",
			symbol: "WAVAX",
			fiatBalance: 8,
			price: "8",
			_price: 8,
			_fiatBalance: "8",
			image: "https://cdn.example/wavax.png",
		});
		const fakeAvax = token({
			address: "0x1111111111111111111111111111111111111111",
			name: "Fake AVAX",
			symbol: "AVAX",
			fiatBalance: 3,
			price: "3",
			_price: 3,
			_fiatBalance: "3",
		});

		const zeroAddressAvax = {
			address: "0x0000000000000000000000000000000000000000",
			symbol: "AVAX",
			tokenType: "ERC-20",
			fiatBalance: 7,
			price: "7",
			name: "Zero AVAX",
		};
		const merged = mergeAvalancheTokenHoldings(
			{ tokens: [plainNative, wrapped, null] },
			{ tokens: [pricedNative, fakeAvax, zeroAddressAvax] }
		);

		expect(merged.tokens.map((entry) => entry.name)).toEqual(["Priced AVAX", "Wrapped AVAX", "Fake AVAX"]);
		expect(merged.tokens.filter((entry) => entry.tokenType === "AVAX")).toHaveLength(1);
		expect(merged.balance).toBe("31");
		expect(merged.total).toBe(3);
		expect(merged.tokens[0]).toMatchObject({
			_fiatBalance: "20",
			_price: 20,
			image: "https://cdn.zelf.world/icons/ic_avax.png",
		});
	});

	it("returns an empty holdings object when both lists are empty", () => {
		expect(mergeAvalancheTokenHoldings({ tokens: [] }, { tokens: [null, "skip"] })).toEqual({
			balance: "0",
			total: 0,
			tokens: [],
		});
	});
});
