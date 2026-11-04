const mockGet = jest.fn();
const mockPost = jest.fn();

jest.mock("axios", () => {
    const actual = jest.requireActual("axios");
    return {
        ...actual,
        create: jest.fn(() => ({ get: (...args) => mockGet(...args), post: (...args) => mockPost(...args) })),
        get: jest.fn(async () => ({ data: { price: 0.00002 } })),
    };
});

jest.mock("../../Repositories/binance/modules/binance.module", () => ({ getTickerPrice: jest.fn() }));

const ADDRESS = "0x1BC125bC681685f216935798453F70fb423eB392";

describe("BlockDAG history fallback", () => {
    let getTransactionsList;

    beforeEach(() => {
        mockGet.mockReset();
        mockPost.mockReset();
        process.env.BLOCKDAG_BLOCKSCOUT_URLS = "https://explorer.test";
        jest.spyOn(console, "warn").mockImplementation(() => {});
        jest.spyOn(console, "log").mockImplementation(() => {});
        jest.spyOn(console, "error").mockImplementation(() => {});
        jest.isolateModules(() => {
            ({ getTransactionsList } = require("../../Repositories/BlockDAG/modules/blockdag.module"));
        });
    });

    afterEach(() => {
        delete process.env.BLOCKDAG_BLOCKSCOUT_URLS;
        jest.restoreAllMocks();
    });

    it("reads Blockscout when bdagscan fails and keeps the chain timestamp as the calendar date", async () => {
        mockGet.mockImplementation(async (url) => {
            if (String(url).includes("getTransactionByAddress")) {
                const error = new Error("blocked");
                error.response = { status: 403 };
                throw error;
            }
            if (String(url).includes("explorer.test")) {
                return {
                    status: 200,
                    data: {
                        items: [
                            {
                                hash: "0xabc",
                                timestamp: "2026-06-17T02:25:39.000000Z",
                                from: { hash: "0x1111111111111111111111111111111111111111" },
                                to: { hash: ADDRESS },
                                value: "1000000000000000000",
                                status: "ok",
                                result: "success",
                                block_number: 10,
                                raw_input: "0x",
                                fee: { value: "21000000000000" },
                            },
                        ],
                    },
                };
            }
            throw new Error(`unexpected ${url}`);
        });

        const result = await getTransactionsList({ address: ADDRESS, page: "0", show: "20" });

        expect(result.error).toBeUndefined();
        expect(result.source).toBe("blockscout");
        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].date).toBe("2026-06-17 02:25:39");
        expect(result.transactions[0].traffic).toBe("IN");
        expect(result.transactions[0].amount).toBe("1");
        expect(result.transactions[0].asset).toBe("BDAG");
        expect(result.transactions[0].timestamp).toBe(Math.floor(Date.parse("2026-06-17T02:25:39.000000Z") / 1000));
    });

    it("returns HISTORY_UNAVAILABLE when bdagscan, Blockscout, and the RPC history method all fail", async () => {
        mockGet.mockRejectedValue(new Error("down"));
        mockPost.mockResolvedValue({ data: { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not found" } } });

        const result = await getTransactionsList({ address: ADDRESS, page: "0", show: "20" });

        expect(result.error).toBe("HISTORY_UNAVAILABLE");
        expect(result.transactionsUnavailable).toBe(true);
        expect(result.transactions).toEqual([]);
    });
});
