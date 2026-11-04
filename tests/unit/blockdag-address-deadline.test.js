// The explorer (api.bdagscan.com) hangs; the RPC answers. getAddress must still answer
// within the apps' ~8 s window, with the RPC balance and no fake "Error" transaction (#580).
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

const hang = () => new Promise(() => {});
const ADDRESS = "0x1BC125bC681685f216935798453F70fb423eB392";

const rpcBalance = (hexWei) => async (url, body) => {
    if (body.method === "eth_getBalance") return { data: { jsonrpc: "2.0", id: 1, result: hexWei } };
    return { data: { jsonrpc: "2.0", id: 1, result: "0x" } };
};

describe("BlockDAG getAddress with a hanging explorer", () => {
    let BlockDAG;

    beforeEach(() => {
        jest.useFakeTimers();
        mockGet.mockReset();
        mockPost.mockReset();
        jest.spyOn(console, "warn").mockImplementation(() => {});
        jest.spyOn(console, "error").mockImplementation(() => {});
        jest.spyOn(console, "log").mockImplementation(() => {});
        jest.isolateModules(() => {
            BlockDAG = require("../../Repositories/BlockDAG/modules/blockdag.module");
        });
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it("answers by the step deadline with the RPC balance and an empty history flagged unavailable", async () => {
        mockGet.mockImplementation(hang);
        mockPost.mockImplementation(rpcBalance("0x674b3f2ced7ae69fed"));

        let settled = false;
        const pending = BlockDAG.getAddress({ address: ADDRESS }).then((r) => {
            settled = true;
            return r;
        });

        await jest.advanceTimersByTimeAsync(4999);
        expect(settled).toBe(false);
        await jest.advanceTimersByTimeAsync(10);

        const result = await pending;
        expect(settled).toBe(true);
        expect(result.error).toBeUndefined();
        expect(Number(result.balance)).toBeCloseTo(1905.4367, 3);
        expect(result.transactions).toEqual([]);
        expect(result.transactionsUnavailable).toBe(true);
        expect(result.tokenHoldings.tokens[0].symbol).toBe("BDAG");
    });

    it("uses the explorer balance and history when the explorer answers", async () => {
        mockGet.mockImplementation(async (url) => {
            if (String(url).includes("getAddressInfo")) {
                return { data: { status: 200, data: { balance: 12.5, firstTransaction: "a", lastTransaction: "b" } } };
            }
            if (String(url).includes("getTransactionByAddress")) {
                return {
                    data: {
                        status: 200,
                        data: [{ txnHash: "0xabc", from: ADDRESS, to: "0xdef", value: "1", timestamp: 1790000000 }],
                    },
                };
            }
            return hang();
        });
        mockPost.mockImplementation(rpcBalance("0x0"));

        const pending = BlockDAG.getAddress({ address: ADDRESS });
        await jest.advanceTimersByTimeAsync(5100);
        const result = await pending;

        expect(result.balance).toBe("12.5");
        expect(result.firstTransaction).toBe("a");
        expect(result.transactionsUnavailable).toBe(false);
        expect(result.transactions).toHaveLength(1);
    });

    it("fetchBdagBalance falls back to the RPC within the explorer deadline", async () => {
        mockGet.mockImplementation(hang);
        mockPost.mockImplementation(rpcBalance("0xde0b6b3a7640000"));

        const pending = BlockDAG.fetchBdagBalance(ADDRESS);
        await jest.advanceTimersByTimeAsync(4100);

        await expect(pending).resolves.toEqual({ balance: "1", firstTransaction: null, lastTransaction: null });
    });
});
