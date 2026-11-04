jest.mock("axios");
jest.mock("../../Repositories/TON/modules/ton-api.client");
jest.mock("../../Repositories/binance/modules/binance.module", () => ({
    getTickerPrice: jest.fn().mockResolvedValue({ price: "1.5" }),
}));
jest.mock("../../Repositories/Solana/modules/oklink", () => ({
    get_ApiKey: () => ({ getApiKey: () => "test-key" }),
}));
jest.mock("../../Repositories/sui/modules/sui-graphql.client", () => ({
    querySuiGraphql: jest.fn(),
}));

const { tonApiGet } = require("../../Repositories/TON/modules/ton-api.client");
const { querySuiGraphql } = require("../../Repositories/sui/modules/sui-graphql.client");
const SuiModule = require("../../Repositories/sui/modules/sui-scrapping.module");
const TonModule = require("../../Repositories/TON/modules/ton-scrapping.module");

describe("chain tokens endpoint payload shape", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("sui getTokens returns { balance, total, tokens } even when the address has no coins", async () => {
        querySuiGraphql.mockResolvedValue({
            address: { balances: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
        });

        const result = await SuiModule.getTokens({ id: "0xabc" }, { page: "0", show: "10" });

        expect(result).toMatchObject({ balance: "0", total: 0, tokens: [] });
        expect(Array.isArray(result.tokens)).toBe(true);
    });

    it("sui getTokens maps GraphQL coin balances into tokens array", async () => {
        querySuiGraphql.mockResolvedValue({
            address: {
                balances: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                        {
                            coinType: { repr: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI" },
                            totalBalance: "1000000000",
                            coinMetadata: { decimals: 9, name: "Sui", symbol: "SUI", iconUrl: "https://example.com/sui.png" },
                        },
                    ],
                },
            },
        });

        const result = await SuiModule.getTokens({ id: "0xabc" }, { page: "0", show: "10" });

        expect(Array.isArray(result.tokens)).toBe(true);
        expect(result.total).toBe(1);
        expect(result.tokens[0].symbol).toBe("SUI");
        expect(result.tokens[0].decimals).toBe(9);
        expect(result.tokens[0].amount).toBe("1");
    });

    it("ton getTokens returns { balance, total, tokens }", async () => {
        tonApiGet.mockImplementation(async (path) => {
            if (path.includes("/jettons")) {
                return { balances: [] };
            }
            if (path.includes("/events")) {
                return { events: [] };
            }
            return { balance: 1000000000 };
        });

        const result = await TonModule.getTokens({ id: "EQBHyu-oZVDHRYQ1-rKlGqpHy5yAqanPBirEQNMNOmfHLotW" }, { page: "0", show: "10" });

        expect(Array.isArray(result.tokens)).toBe(true);
        expect(typeof result.total).toBe("number");
        expect(result.tokens.some((token) => token.symbol === "TON")).toBe(true);
    });
});
