const mockAxiosPost = jest.fn();
const mockAxiosGet = jest.fn();
const mockInstanceGet = jest.fn();

jest.mock("axios", () => {
    const axios = jest.fn();
    axios.post = (...args) => mockAxiosPost(...args);
    axios.get = (...args) => mockAxiosGet(...args);
    axios.create = jest.fn(() => ({ get: mockInstanceGet }));
    return axios;
});

jest.mock("../../Core/helpers", () => ({
    generateRandomUserAgent: () => "test-agent",
}));

jest.mock("../../Repositories/binance/modules/binance.module", () => ({
    getTickerPrice: jest.fn(async () => ({ price: "20" })),
}));

jest.mock("../../Repositories/Solana/modules/oklink", () => ({
    get_ApiKey: () => ({ getApiKey: () => "oklink-key" }),
}));

const { getBalance } = require("../../Repositories/Avalanche/modules/avalanche-scrapping.module");

const ADDRESS = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";

describe("avalanche getBalance upstream fallbacks", () => {
    beforeEach(() => {
        mockAxiosPost.mockReset();
        mockAxiosGet.mockReset();
        mockInstanceGet.mockReset();
    });

    it("returns native balance when Glacier holdings respond 403", async () => {
        mockAxiosPost.mockImplementation(async (_url, body) => {
            if (body?.method === "eth_getBalance") {
                return { data: { result: "0xde0b6b3a7640000" } };
            }
            return { data: { code: "0", data: { hits: [] } } };
        });
        mockInstanceGet.mockImplementation(async (url) => {
            if (String(url).includes("glacier-api.avax.network")) {
                throw { response: { status: 403 } };
            }
            if (String(url).includes("erc20-holdings")) {
                throw new Error("routescan_holdings_unavailable");
            }
            throw new Error(`unexpected url ${url}`);
        });
        mockAxiosGet.mockResolvedValue({
            data: { code: "0", data: { hits: [] } },
        });

        const result = await getBalance({ id: ADDRESS });

        expect(result.balance).toBe("1.0");
        expect(result.tokenHoldings.tokens[0].symbol).toBe("AVAX");
        expect(result.transactions).toEqual([]);
        expect(result.partial).toBe(true);
        expect(result.tokensFailed).toBe(true);
        expect(result.transactionsFailed).toBe(false);
        expect(result.tokensError).toBeTruthy();
    });
});
