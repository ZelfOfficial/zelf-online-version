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
        mockInstanceGet.mockImplementation(async (url, options) => {
            const action = options?.params?.action;
            if (action === "txlist") {
                return { data: { status: "0", message: "No transactions found", result: "No transactions found" } };
            }
            if (action === "addresstokenbalance" || action === "tokentx" || action === "tokenbalance") {
                throw new Error("routescan_tokens_down");
            }
            if (String(url).includes("glacier-api.avax.network")) {
                throw { response: { status: 403 } };
            }
            if (String(url).includes("erc20-holdings")) {
                throw new Error("routescan_holdings_unavailable");
            }
            throw new Error(`unexpected url ${url}`);
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

    it("merges Routescan and Glacier tokens and keeps native AVAX once", async () => {
        mockAxiosPost.mockImplementation(async (_url, body) => {
            if (body?.method === "eth_getBalance") {
                return { data: { result: "0xde0b6b3a7640000" } };
            }
            return { data: { result: "0x0" } };
        });
        mockInstanceGet.mockImplementation(async (url, options) => {
            const action = options?.params?.action;
            if (action === "txlist") {
                return { data: { status: "0", message: "No transactions found", result: "No transactions found" } };
            }
            if (action === "addresstokenbalance") {
                return {
                    data: {
                        status: "1",
                        message: "OK",
                        result: [
                            {
                                TokenAddress: "0x0000000000000000000000000000000000000000",
                                TokenName: "Avalanche",
                                TokenSymbol: "AVAX",
                                TokenQuantity: "5000000000000000000",
                                TokenDivisor: "18",
                                TokenPriceUSD: "20",
                            },
                            {
                                TokenAddress: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
                                TokenName: "USD Coin",
                                TokenSymbol: "USDC",
                                TokenQuantity: "2000000",
                                TokenDivisor: "6",
                                TokenPriceUSD: "1",
                            },
                        ],
                    },
                };
            }
            if (String(url).includes("glacier-api.avax.network") && String(url).includes("balances:listErc20")) {
                return {
                    data: {
                        erc20TokenBalances: [
                            {
                                address: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e",
                                balance: "2000000",
                                decimals: 6,
                                name: "USD Coin Glacier",
                                symbol: "USDC",
                                ercType: "ERC-20",
                                logoUri: "https://cdn.example/usdc.png",
                                balanceValue: { value: 9 },
                                price: { value: 1 },
                            },
                            {
                                address: "0x6e84a6216eA6dACC71eE8E6b0a5B7322EEbC0fDd",
                                balance: "1000000000000000000",
                                decimals: 18,
                                name: "JoeToken",
                                symbol: "JOE",
                                ercType: "ERC-20",
                                logoUri: "https://cdn.example/joe.png",
                                balanceValue: { value: 20 },
                                price: { value: 5 },
                            },
                            {
                                address: "0x0000000000000000000000000000000000000000",
                                balance: "1000000000000000000",
                                decimals: 18,
                                name: "Avalanche Glacier",
                                symbol: "AVAX",
                                ercType: "AVAX",
                                logoUri: "https://cdn.example/avax.png",
                                balanceValue: { value: 7 },
                                price: { value: 7 },
                            },
                        ],
                    },
                };
            }
            if (String(url).includes("cdn.routescan.io")) {
                return { data: { erc20Count: 2, erc721Count: 0, erc1155Count: 0 } };
            }
            throw new Error(`unexpected url ${url} ${action || ""}`);
        });

        const result = await getBalance({ id: ADDRESS });
        const avax = result.tokenHoldings.tokens.filter((token) => token.symbol === "AVAX");

        expect(result.tokensFailed).toBe(false);
        expect(result.partial).toBe(false);
        expect(avax).toHaveLength(1);
        expect(result.tokenHoldings.tokens[0]).toMatchObject({
            amount: "1.0",
            name: "Avalanche",
            symbol: "AVAX",
            tokenType: "AVAX",
            image: "https://cdn.zelf.world/icons/ic_avax.png",
        });
        expect(Object.keys(result.tokenHoldings.tokens[0]).sort()).toEqual(
            ["amount", "decimals", "fiatBalance", "image", "name", "price", "symbol", "tokenType"].sort()
        );
        expect(result.tokenHoldings.tokens.map((token) => token.symbol)).toEqual(["AVAX", "USDC", "JOE"]);
        expect(result.tokenHoldings.tokens.filter((token) => token.symbol === "USDC")).toHaveLength(1);
        expect(result.tokenHoldings.balance).toBe("22");
        expect(result.tokenHoldings.total).toBe(2);
        expect(JSON.stringify(mockInstanceGet.mock.calls)).not.toMatch(/oklink/i);
    });
});
