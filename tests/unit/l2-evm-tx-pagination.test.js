jest.mock("dotenv", () => ({
	config: jest.fn(),
}));

const mockFetchBlockscout = jest.fn();
const mockLadder = jest.fn();
const mockRace = jest.fn();

jest.mock("../../Repositories/etherscan/modules/evm-transaction-list.util", () => {
	const actual = jest.requireActual("../../Repositories/etherscan/modules/evm-transaction-list.util");
	return {
		...actual,
		fetchTransactionsFromBlockscout: (...args) => mockFetchBlockscout(...args),
		fetchTransactionsFromEtherscanV2: jest.fn().mockRejectedValue(new Error("etherscan_unavailable")),
		runTransactionProviderRace: (...args) => mockRace(...args),
		runTransactionProviderLadder: (...args) => mockLadder(...args),
	};
});

jest.mock("../../Repositories/binance/modules/binance.module", () => ({
	getTickerPrice: jest.fn(async () => ({ price: "3000" })),
}));

jest.mock("../../Repositories/Solana/modules/oklink", () => ({
	get_ApiKey: () => ({ getApiKey: () => "test-oklink-key" }),
}));

const TEST_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

const loadOptimismModule = () => {
	let mod;
	jest.isolateModules(() => {
		mod = require("../../Repositories/optimism/modules/optimism-scrapping.module");
	});
	return mod;
};

const loadArbitrumModule = () => {
	let mod;
	jest.isolateModules(() => {
		mod = require("../../Repositories/arbitrum/modules/arbitrum-scrapping.module");
	});
	return mod;
};

describe("L2 EVM tx pagination (OP/ARB)", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockRace.mockResolvedValue(null);
	});

	it("Optimism getTransactionsList returns incomplete ladder responses", async () => {
		mockLadder.mockResolvedValue({
			transactions: [],
			incomplete: true,
			hasMore: true,
			pagination: { incomplete: true, hasMore: true },
		});

		const { getTransactionsList } = loadOptimismModule();
		const result = await getTransactionsList({ address: TEST_ADDRESS, page: "4", show: "25", deadlineMs: 12000 });

		expect(result.incomplete).toBe(true);
		expect(result.hasMore).toBe(true);
		expect(result.transactions).toEqual([]);
	});

	it("Arbitrum getTransactionsList returns incomplete ladder responses", async () => {
		mockLadder.mockResolvedValue({
			transactions: [],
			incomplete: true,
			hasMore: true,
			pagination: { incomplete: true, hasMore: true },
		});

		const { getTransactionsList } = loadArbitrumModule();
		const result = await getTransactionsList({ address: TEST_ADDRESS, page: "4", show: "25", deadlineMs: 12000 });

		expect(result.incomplete).toBe(true);
		expect(result.hasMore).toBe(true);
	});

	it("Optimism page>1 uses Blockscout first and passes walk deadline to fetch", async () => {
		mockFetchBlockscout.mockResolvedValue({
			items: [
				{
					hash: "0xabc",
					from: { hash: "0xa" },
					to: { hash: "0xb" },
					value: "0",
					timestamp: "2024-01-01T00:00:00.000000Z",
				},
			],
			nextPageParams: null,
		});

		mockLadder.mockImplementation(async (providers) => {
			expect(providers).toHaveLength(3);
			return providers[0](4000, 11500);
		});

		const { getTransactionsList } = loadOptimismModule();
		const result = await getTransactionsList({ address: TEST_ADDRESS, page: "4", show: "25", deadlineMs: 12000 });

		expect(result.transactions.length).toBeGreaterThan(0);
		expect(mockFetchBlockscout).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({ deadlineMs: 11500, timeout: 4000, page: 4 })
		);
	});
});
