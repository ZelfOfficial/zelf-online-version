const mockInstanceGet = jest.fn();
const mockAxiosGet = jest.fn();
const mockGetTickerPrice = jest.fn();
const mockGetApiKey = jest.fn();

jest.mock("axios", () => {
	const axios = jest.fn();
	axios.get = (...args) => mockAxiosGet(...args);
	return axios;
});

jest.mock("../../Core/axios", () => ({
	getCleanInstance: () => ({ get: mockInstanceGet, post: jest.fn() }),
}));

jest.mock("../../Repositories/binance/modules/binance.module", () => ({
	getTickerPrice: (...args) => mockGetTickerPrice(...args),
}));

jest.mock("../../Repositories/Solana/modules/oklink", () => ({
	get_ApiKey: () => ({ getApiKey: (...args) => mockGetApiKey(...args) }),
}));

jest.mock("../../Repositories/etherscan/modules/ethereum-address-holdings.util", () => ({
	buildNativeEthHoldingRow: jest.fn(),
	getEthereumPortfolioViaAlchemy: jest.fn(),
	getEthereumPortfolioViaEthplorer: jest.fn(),
	isAlchemyEthereumConfigured: jest.fn(() => false),
	sumFiatBalance: jest.fn(() => 0),
}));

const { getTransactionsList } = require("../../Repositories/etherscan/modules/etherscan-scrapping.module");

const TEST_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

describe("etherscan-scrapping.module getTransactionsList", () => {
	beforeEach(() => {
		mockInstanceGet.mockReset();
		mockAxiosGet.mockReset();
		mockGetTickerPrice.mockReset();
		mockGetApiKey.mockReset();
		mockGetTickerPrice.mockResolvedValue({ price: 2500 });
		mockGetApiKey.mockReturnValue("test-oklink-key");
		delete process.env.MICROSERVICES_BOGOTA_URL;
		delete process.env.MICROSERVICES_BOGOTA_TOKEN;
	});

	it("returns RouteScan transactions when the public indexer responds", async () => {
		mockInstanceGet.mockResolvedValueOnce({
			data: {
				items: [
					{
						id: "0xroute",
						blockNumber: 1,
						timestamp: "2024-01-01T00:00:00.000Z",
						from: "0xsender",
						to: TEST_ADDRESS,
						value: "1000000000000000000",
						gasUsed: "21000",
						gasPrice: "1000000000",
					},
				],
			},
		});

		const result = await getTransactionsList({ address: TEST_ADDRESS, show: "5" });

		expect(result.source).toBe("routescan");
		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0].hash).toBe("0xroute");
	});

	it("falls back to Bogota microservice when public providers are empty", async () => {
		process.env.MICROSERVICES_BOGOTA_URL = "https://bogota.test";
		process.env.MICROSERVICES_BOGOTA_TOKEN = "token";

		mockInstanceGet.mockRejectedValueOnce(new Error("routescan down")).mockResolvedValueOnce({
			data: [{ hash: "0xbogota", amount: "1" }],
		});

		mockAxiosGet.mockResolvedValueOnce({ data: { code: "1", data: { hits: [] } } });
		mockGetApiKey.mockReturnValue("test-oklink-key");

		const result = await getTransactionsList({ address: TEST_ADDRESS, show: "5" });

		expect(result.source).toBe("bogota");
		expect(result.transactions[0].hash).toBe("0xbogota");
	});
});
