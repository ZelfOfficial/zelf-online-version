jest.mock("../../Core/config", () => ({
	etherscan: { apiKey: "infura-should-not-be-used" },
}));

const {
	mapEtherscanV2Transaction,
	mapRouteScanTransaction,
	mapBlockscoutTransaction,
	buildListResponse,
	fetchTransactionsFromEtherscanV2,
	fetchTransactionsFromRouteScan,
	fetchTransactionsFromBlockscout,
	normalizeTransactionLimit,
	normalizeUnixTimestampSeconds,
	formatDecimalString,
	weiToEthDecimalString,
	resolveEtherscanApiKey,
} = require("../../Repositories/etherscan/modules/evm-transaction-list.util");
const StandardizedChainFormatter = require("../../Repositories/class/standardized-chain-formatter");

const TEST_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const optimismFormatter = new StandardizedChainFormatter("OP Mainnet", "ETH", "https://example.com/eth.png");

describe("evm-transaction-list.util", () => {
	const prevEtherscanKey = process.env.ETHERSCAN_API_KEY;

	afterEach(() => {
		if (prevEtherscanKey === undefined) delete process.env.ETHERSCAN_API_KEY;
		else process.env.ETHERSCAN_API_KEY = prevEtherscanKey;
	});

	it("normalizes transaction limits", () => {
		expect(normalizeTransactionLimit("200")).toBe(100);
		expect(normalizeTransactionLimit(undefined, 10)).toBe(10);
	});

	it("normalizes unix timestamps from seconds, milliseconds, and ISO", () => {
		expect(normalizeUnixTimestampSeconds(1700000000)).toBe(1700000000);
		expect(normalizeUnixTimestampSeconds(1700000000000)).toBe(1700000000);
		expect(normalizeUnixTimestampSeconds("2024-06-01T12:00:00.000000Z")).toBe(
			Math.floor(Date.parse("2024-06-01T12:00:00.000000Z") / 1000)
		);
	});

	it("formats tiny amounts without exponent notation", () => {
		expect(formatDecimalString("0.000000000001")).toBe("0.000000000001");
		expect(formatDecimalString(weiToEthDecimalString("10000000000000"))).not.toMatch(/e/i);
	});

	it("maps Etherscan V2 rows with price and timestamp", () => {
		const row = mapEtherscanV2Transaction(
			{
				hash: "0xabc",
				blockNumber: "123",
				from: TEST_ADDRESS,
				to: "0xreceiver",
				value: "1000000000000000000",
				timeStamp: "1700000000",
				gasUsed: "21000",
				gasPrice: "1000000000",
			},
			TEST_ADDRESS,
			{ asset: "ETH", price: 2000 }
		);

		expect(row).toMatchObject({
			hash: "0xabc",
			timestamp: 1700000000,
			price: 2000,
			fiatAmount: "2000.00",
			amount: "1",
		});
	});

	it("maps RouteScan rows with decimal amount and fiat", () => {
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
			TEST_ADDRESS,
			{ asset: "ETH", price: 2500 }
		);

		expect(row.fiatAmount).toBe("2500.00");
		expect(row.timestamp).toBe(Math.floor(Date.parse("2024-01-01T00:00:00.000Z") / 1000));
	});

	it("maps Blockscout rows with nested from/to and ISO timestamp", () => {
		const row = mapBlockscoutTransaction(
			{
				hash: "0xblockscout",
				block: 999,
				timestamp: "2024-06-01T12:00:00.000000Z",
				from: { hash: TEST_ADDRESS },
				to: { hash: "0xreceiver" },
				value: "10000000000000",
				gas_used: "21000",
				gas_price: "1000000000",
				raw_input: "0x",
			},
			TEST_ADDRESS,
			{ asset: "ETH", price: 3000 }
		);

		const formatted = optimismFormatter.formatTransactions([row])[0];
		expect(formatted.date).not.toBe("N/A");
		expect(formatted.timestamp).toBeGreaterThan(0);
		expect(formatted.fiatAmount).not.toBe("0.00");
		expect(formatted.amount).not.toMatch(/e/i);
	});

	it("buildListResponse sets pagination metadata and cursors", () => {
		const response = buildListResponse([{ hash: "0x1" }], {
			page: 2,
			show: 10,
			total: 25,
			nextCursor: "cursor-token",
		});
		expect(response.pagination).toMatchObject({ records: "25", pages: "3", page: "2", nextCursor: "cursor-token" });
	});

	it("fetchTransactionsFromEtherscanV2 rejects without ETHERSCAN_API_KEY env", async () => {
		delete process.env.ETHERSCAN_API_KEY;
		await expect(
			fetchTransactionsFromEtherscanV2(jest.fn(), { chainId: 1, address: TEST_ADDRESS })
		).rejects.toThrow("etherscan_api_key_unconfigured");
		expect(resolveEtherscanApiKey()).toBe("");
	});

	it("fetchTransactionsFromRouteScan walks pages with next tokens", async () => {
		const httpGet = jest
			.fn()
			.mockResolvedValueOnce({
				data: {
					items: [{ id: "0xpage1", from: "0xa", to: "0xb", value: "0", timestamp: "2024-01-01T00:00:00.000Z" }],
					link: { nextToken: "token-2" },
				},
			})
			.mockResolvedValueOnce({
				data: {
					items: [{ id: "0xpage2", from: "0xc", to: "0xd", value: "0", timestamp: "2024-01-02T00:00:00.000Z" }],
					link: { nextToken: "token-3" },
				},
			});

		const page2 = await fetchTransactionsFromRouteScan(httpGet, {
			chainId: 1,
			address: TEST_ADDRESS,
			limit: 1,
			page: 2,
		});

		expect(page2.items[0].id).toBe("0xpage2");
		expect(httpGet).toHaveBeenCalledTimes(2);
	});

	it("fetchTransactionsFromBlockscout walks next_page_params", async () => {
		const httpGet = jest
			.fn()
			.mockResolvedValueOnce({
				data: {
					items: [{ hash: "0x1", from: { hash: "0xa" }, to: { hash: "0xb" }, value: "0", timestamp: "2024-01-01T00:00:00.000000Z" }],
					next_page_params: { block_number: 10, index: 1 },
				},
			})
			.mockResolvedValueOnce({
				data: {
					items: [{ hash: "0x2", from: { hash: "0xc" }, to: { hash: "0xd" }, value: "0", timestamp: "2024-01-02T00:00:00.000000Z" }],
					next_page_params: null,
				},
			});

		const page2 = await fetchTransactionsFromBlockscout(httpGet, {
			baseUrl: "https://explorer.optimism.io",
			address: TEST_ADDRESS,
			limit: 1,
			page: 2,
		});

		expect(page2.items[0].hash).toBe("0x2");
		expect(httpGet.mock.calls[1][1].params).toMatchObject({ block_number: 10, index: 1 });
	});
});
