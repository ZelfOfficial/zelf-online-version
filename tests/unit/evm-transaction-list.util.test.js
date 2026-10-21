const {
	mapEtherscanV2Transaction,
	mapRouteScanTransaction,
	mapBlockscoutTransaction,
	mapRpcTransaction,
	buildListResponse,
	fetchTransactionsFromEtherscanV2,
	fetchTransactionsFromRouteScan,
	fetchTransactionsFromBlockscout,
	normalizeTransactionLimit,
} = require("../../Repositories/etherscan/modules/evm-transaction-list.util");

const TEST_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

describe("evm-transaction-list.util", () => {
	it("normalizes transaction limits", () => {
		expect(normalizeTransactionLimit("200")).toBe(100);
		expect(normalizeTransactionLimit(undefined, 10)).toBe(10);
	});

	it("maps Etherscan V2 rows", () => {
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
			block: "123",
			from: TEST_ADDRESS,
			to: "0xreceiver",
			amount: "1",
			asset: "ETH",
			traffic: "OUT",
		});
	});

	it("maps RouteScan rows", () => {
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

		expect(row).toMatchObject({
			hash: "0xroutescan",
			block: "456",
			traffic: "IN",
			asset: "ETH",
		});
	});

	it("maps JSON-RPC transaction rows", () => {
		const row = mapRpcTransaction(
			{
				hash: "0xrpc",
				blockNumber: "0x64",
				from: TEST_ADDRESS,
				to: "0xreceiver",
				value: "0xde0b6b3a7640000",
				gas: "0x5208",
				gasPrice: "0x3b9aca00",
				input: "0x",
				timestamp: 1700000000,
			},
			TEST_ADDRESS,
			{ asset: "ETH", price: 1000 }
		);

		expect(row.hash).toBe("0xrpc");
		expect(row.traffic).toBe("OUT");
	});

	it("maps Blockscout rows with nested from/to", () => {
		const row = mapBlockscoutTransaction(
			{
				hash: "0xblockscout",
				block: 999,
				timestamp: "2024-06-01T12:00:00.000000Z",
				from: { hash: TEST_ADDRESS },
				to: { hash: "0xreceiver" },
				value: "2000000000000000000",
				gas_used: "21000",
				gas_price: "1000000000",
				raw_input: "0x",
			},
			TEST_ADDRESS,
			{ asset: "ETH", price: 3000 }
		);

		expect(row).toMatchObject({
			hash: "0xblockscout",
			from: TEST_ADDRESS,
			to: "0xreceiver",
			traffic: "OUT",
		});
	});

	it("buildListResponse sets pagination metadata", () => {
		const response = buildListResponse([{ hash: "0x1" }], { page: 2, show: 10, total: 25 });
		expect(response.pagination).toEqual({ records: "25", pages: "3", page: "2" });
		expect(response.transactions).toHaveLength(1);
	});

	it("fetchTransactionsFromEtherscanV2 rejects without API key", async () => {
		const prev = process.env.ETHERSCAN_API_KEY;
		delete process.env.ETHERSCAN_API_KEY;
		jest.resetModules();
		const util = require("../../Repositories/etherscan/modules/evm-transaction-list.util");

		await expect(
			util.fetchTransactionsFromEtherscanV2(jest.fn(), { chainId: 1, address: TEST_ADDRESS })
		).rejects.toThrow("etherscan_api_key_unconfigured");

		if (prev) process.env.ETHERSCAN_API_KEY = prev;
	});

	it("fetchTransactionsFromRouteScan uses http client", async () => {
		const httpGet = jest.fn().mockResolvedValue({
			data: { items: [{ id: "0x1", from: "0xa", to: "0xb", value: "0", timestamp: "2024-01-01T00:00:00.000Z" }] },
		});

		const items = await fetchTransactionsFromRouteScan(httpGet, { chainId: 1, address: TEST_ADDRESS, limit: 5 });
		expect(items).toHaveLength(1);
		expect(httpGet).toHaveBeenCalled();
	});

	it("fetchTransactionsFromBlockscout uses blockscout base URL", async () => {
		const httpGet = jest.fn().mockResolvedValue({
			data: { items: [{ hash: "0x1", from: { hash: "0xa" }, to: { hash: "0xb" }, value: "0", timestamp: "2024-01-01T00:00:00.000000Z" }] },
		});

		const items = await fetchTransactionsFromBlockscout(httpGet, {
			baseUrl: "https://explorer.optimism.io",
			address: TEST_ADDRESS,
			limit: 3,
		});

		expect(items).toHaveLength(1);
		expect(httpGet.mock.calls[0][0]).toContain("explorer.optimism.io");
	});
});
