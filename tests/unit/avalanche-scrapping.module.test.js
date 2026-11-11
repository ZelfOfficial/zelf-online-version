const mockAxiosGet = jest.fn();
const mockInstanceGet = jest.fn();
const mockGetApiKey = jest.fn();

jest.mock("axios", () => {
	const mockAxios = jest.fn();
	mockAxios.get = mockAxiosGet;
	mockAxios.create = jest.fn(() => ({ get: mockInstanceGet }));
	return mockAxios;
});

jest.mock("../../Core/helpers", () => ({
	generateRandomUserAgent: () => "test-user-agent",
}));

jest.mock("../../Repositories/Solana/modules/oklink", () => ({
	get_ApiKey: () => ({ getApiKey: (...args) => mockGetApiKey(...args) }),
}));

jest.mock("../../Repositories/binance/modules/binance.module", () => ({
	getTickerPrice: jest.fn(),
}));

const { getTransactionsList, getTokens } = require("../../Repositories/Avalanche/modules/avalanche-scrapping.module");
const {
	mapOkLinkTransaction,
	mapEtherscanAccountTransaction,
	mapRouteScanTransaction,
	mapGlacierTransaction,
} = require("../../Repositories/Avalanche/modules/avalanche-transaction.util");

const TEST_ADDRESS = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";

describe("avalanche-transaction.util", () => {
	it("maps OKLink rows into the standard transaction shape", () => {
		const row = mapOkLinkTransaction(
			{
				hash: "0xabc",
				blockHeight: 123,
				blocktime: 1700000000,
				from: TEST_ADDRESS,
				to: "0xreceiver",
				value: 1.2345,
				method: "swapExact",
				realValue: -1.2345,
				fee: 0.0012,
			},
			TEST_ADDRESS
		);

		expect(row).toMatchObject({
			hash: "0xabc",
			block: "123",
			from: TEST_ADDRESS,
			to: "0xreceiver",
			amount: "1.2345",
			asset: "AVAX",
			method: "Swap",
			traffic: "OUT",
			txnFee: "0.0012",
			timestamp: 1700000000,
		});
	});

	it("maps Routescan Etherscan txlist rows into the standard transaction shape", () => {
		const row = mapEtherscanAccountTransaction(
			{
				hash: "0xetherscan",
				blockNumber: "321",
				timeStamp: "1700000000",
				from: TEST_ADDRESS,
				to: "0xreceiver",
				value: "1000000000000000000",
				gasUsed: "21000",
				gasPrice: "1000000000",
				functionName: "swapExactTokensForTokens(uint256)",
			},
			TEST_ADDRESS
		);

		expect(row).toMatchObject({
			hash: "0xetherscan",
			block: "321",
			from: TEST_ADDRESS,
			to: "0xreceiver",
			amount: "1.0000",
			asset: "AVAX",
			method: "Swap",
			traffic: "OUT",
			txnFee: "0.0000",
			timestamp: 1700000000,
		});
		expect(Object.keys(row)).toEqual(["age", "amount", "asset", "block", "date", "from", "hash", "method", "to", "traffic", "txnFee", "timestamp"]);
	});

	it("maps RouteScan rows into the standard transaction shape", () => {
		const row = mapRouteScanTransaction(
			{
				id: "0xroutescan",
				blockNumber: 456,
				timestamp: "2024-01-01T00:00:00.000Z",
				from: "0xsender",
				to: TEST_ADDRESS,
				value: "1000000000000000000",
				gasUsed: "21000",
				gasPrice: "1000000000",
			},
			TEST_ADDRESS
		);

		expect(row).toMatchObject({
			hash: "0xroutescan",
			block: "456",
			from: "0xsender",
			to: TEST_ADDRESS,
			amount: "1.0000",
			asset: "AVAX",
			method: "Transfer",
			traffic: "IN",
			txnFee: "0.0000",
			timestamp: 1704067200,
		});
	});

	it("maps Glacier rows into the standard transaction shape", () => {
		const row = mapGlacierTransaction(
			{
				nativeTransaction: {
					txHash: "0xglacier",
					blockNumber: "789",
					blockTimestamp: 1700000100,
					from: { address: TEST_ADDRESS },
					to: { address: "0xreceiver" },
					value: "250000000000000000",
					gasUsed: "21000",
					gasPrice: "2000000000",
					method: { methodName: "transfer" },
				},
			},
			TEST_ADDRESS
		);

		expect(row).toMatchObject({
			hash: "0xglacier",
			block: "789",
			from: TEST_ADDRESS,
			to: "0xreceiver",
			amount: "0.2500",
			asset: "AVAX",
			method: "transfer",
			traffic: "OUT",
			txnFee: "0.0000",
			timestamp: 1700000100,
		});
	});
});

const etherscanTx = (hash, timeStamp) => ({
	hash,
	blockNumber: "100",
	timeStamp: String(timeStamp),
	from: "0xsender",
	to: TEST_ADDRESS,
	value: "500000000000000000",
	gasUsed: "21000",
	gasPrice: "1000000000",
	functionName: "",
});

describe("getTransactionsList", () => {
	beforeEach(() => {
		mockAxiosGet.mockReset();
		mockInstanceGet.mockReset();
		mockGetApiKey.mockReset();
		mockGetApiKey.mockReturnValue("test-oklink-key");
	});

	it("reads Routescan txlist first and keeps newest-first order", async () => {
		mockInstanceGet.mockResolvedValueOnce({
			data: {
				status: "1",
				message: "OK",
				result: [etherscanTx("0xolder", 1700000000), etherscanTx("0xnewer", 1700000500)],
			},
		});

		const result = await getTransactionsList({ id: TEST_ADDRESS, page: "0", show: "10" });

		expect(result.map((tx) => tx.hash)).toEqual(["0xnewer", "0xolder"]);
		expect(result[0]).toMatchObject({
			asset: "AVAX",
			amount: "0.5000",
			traffic: "IN",
			method: "Transfer",
		});
		expect(mockAxiosGet).not.toHaveBeenCalled();
		expect(mockInstanceGet).toHaveBeenCalledTimes(1);
		expect(mockInstanceGet).toHaveBeenCalledWith(
			"https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api",
			expect.objectContaining({
				params: expect.objectContaining({
					module: "account",
					action: "txlist",
					address: TEST_ADDRESS,
					page: 1,
					offset: 10,
					sort: "desc",
				}),
			})
		);
		expect(JSON.stringify(mockInstanceGet.mock.calls)).not.toMatch(/apikey/i);
	});

	it("treats a page index of 1 as the second page", async () => {
		mockInstanceGet.mockResolvedValueOnce({ data: { status: "0", message: "No transactions found", result: "No transactions found" } });

		const result = await getTransactionsList({ id: TEST_ADDRESS, page: "1", show: "25" });

		expect(result).toEqual([]);
		expect(mockInstanceGet.mock.calls[0][1].params.page).toBe(2);
		expect(mockInstanceGet.mock.calls[0][1].params.offset).toBe(25);
	});

	it("falls back to the RouteScan address feed when the etherscan proxy fails", async () => {
		mockInstanceGet
			.mockRejectedValueOnce(Object.assign(new Error("Request failed with status code 400"), { response: { status: 400, data: { message: "device risk check failed" } } }))
			.mockResolvedValueOnce({
				data: {
					items: [
						{
							id: "0xroutescan",
							blockNumber: 200,
							timestamp: "2024-02-01T12:00:00.000Z",
							from: "0xsender",
							to: TEST_ADDRESS,
							value: "500000000000000000",
							gasUsed: "21000",
							gasPrice: "1000000000",
						},
					],
				},
			});

		const result = await getTransactionsList({ id: TEST_ADDRESS, page: "0", show: "10" });

		expect(result).toHaveLength(1);
		expect(result[0].hash).toBe("0xroutescan");
		expect(mockInstanceGet).toHaveBeenCalledWith(
			`https://api.routescan.io/v2/network/mainnet/evm/43114/address/${TEST_ADDRESS}/transactions`,
			expect.objectContaining({ params: { limit: 10 } })
		);
	});

	it("falls back to Glacier when both RouteScan feeds fail", async () => {
		mockInstanceGet
			.mockRejectedValueOnce(new Error("routescan etherscan down"))
			.mockRejectedValueOnce(new Error("routescan address down"))
			.mockResolvedValueOnce({
				data: {
					transactions: [
						{
							nativeTransaction: {
								txHash: "0xglacier",
								blockNumber: "300",
								blockTimestamp: 1700000200,
								from: { address: "0xsender" },
								to: { address: TEST_ADDRESS },
								value: "1000000000000000000",
								gasUsed: "21000",
								gasPrice: "1000000000",
								method: { methodName: "Transfer" },
							},
						},
					],
				},
			});

		const result = await getTransactionsList({ id: TEST_ADDRESS, page: "0", show: "10" });

		expect(result).toHaveLength(1);
		expect(result[0].hash).toBe("0xglacier");
		expect(mockInstanceGet).toHaveBeenLastCalledWith(
			`https://glacier-api.avax.network/v1/chains/43114/addresses/${TEST_ADDRESS}/transactions`,
			expect.objectContaining({ params: { pageSize: 10 } })
		);
	});

	it("returns an empty list instead of throwing when every history provider fails", async () => {
		mockInstanceGet.mockRejectedValue(new Error("fallback down"));

		await expect(getTransactionsList({ id: TEST_ADDRESS, page: "0", show: "10" })).resolves.toEqual([]);
		expect(mockAxiosGet).not.toHaveBeenCalled();
	});
});

describe("getTokens", () => {
	beforeEach(() => {
		mockAxiosGet.mockReset();
		mockInstanceGet.mockReset();
	});

	it("maps Routescan addresstokenbalance rows and keeps API order", async () => {
		mockInstanceGet.mockResolvedValueOnce({
			data: {
				status: "1",
				message: "OK",
				result: [
					{
						TokenAddress: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7",
						TokenName: "TetherToken",
						TokenSymbol: "USDt",
						TokenQuantity: "101000000",
						TokenDivisor: "6",
						TokenPriceUSD: "0.999176",
					},
					{
						TokenAddress: "0xbad",
						TokenQuantity: "nope",
						TokenDivisor: "6",
					},
				],
			},
		});

		const result = await getTokens({ id: TEST_ADDRESS }, { page: "0", show: "10" });

		expect(result.total).toBe(1);
		expect(result.tokens[0]).toMatchObject({
			address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7",
			symbol: "USDt",
			name: "TetherToken",
			decimals: 6,
			amount: "101.0",
			tokenType: "ERC-20",
			price: "0.999176",
		});
		expect(result.tokens[0].fiatBalance).toBeCloseTo(100.916776, 4);
		expect(mockInstanceGet.mock.calls[0][1].params).toMatchObject({
			module: "account",
			action: "addresstokenbalance",
			page: 1,
			offset: 10,
		});
	});

	it("returns an empty token list when every holdings provider fails", async () => {
		mockInstanceGet.mockRejectedValue(new Error("holdings down"));

		await expect(getTokens({ id: TEST_ADDRESS }, { page: "0", show: "10" })).resolves.toEqual({
			balance: "0",
			total: 0,
			tokens: [],
		});
	});
});
