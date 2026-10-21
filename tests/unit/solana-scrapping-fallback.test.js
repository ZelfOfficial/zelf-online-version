jest.mock("../../Repositories/Solana/modules/solscan", () => ({
    getAddress: jest.fn(async () => null),
}));

jest.mock("../../Repositories/Solana/modules/oklink", () => ({
    getAddress: jest.fn(async () => null),
}));

jest.mock("../../Repositories/Solana/modules/solana-source-a-rpc.module", () => ({
    getAddress: jest.fn(async () => ({
        address: "wallet",
        balance: "1.5",
        tokenHoldings: { tokens: [{ amount: 1, symbol: "SOL" }] },
    })),
    getNativeBalanceSummary: jest.fn(async () => null),
}));

const solscan = require("../../Repositories/Solana/modules/solscan");
const oklink = require("../../Repositories/Solana/modules/oklink");
const solanaSourceA = require("../../Repositories/Solana/modules/solana-source-a-rpc.module");
const { getAddress } = require("../../Repositories/Solana/modules/solana-scrapping.module");

describe("solana-scrapping getAddress", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        solscan.getAddress.mockResolvedValue(null);
        oklink.getAddress.mockResolvedValue(null);
        solanaSourceA.getAddress.mockResolvedValue({
            address: "wallet",
            balance: "1.5",
            tokenHoldings: { tokens: [{ amount: 1, symbol: "SOL" }] },
        });
        solanaSourceA.getNativeBalanceSummary.mockResolvedValue(null);
    });

    it("falls back to sourceA RPC when scrapers return empty payloads", async () => {
        const result = await getAddress({ id: "wallet" });

        expect(result.source).toBe("sourceA");
        expect(result.balance).toBe("1.5");
        expect(solanaSourceA.getAddress).toHaveBeenCalled();
    });

    it("throws 502 when every upstream fails", async () => {
        solanaSourceA.getAddress.mockImplementation(async () => null);
        solanaSourceA.getNativeBalanceSummary.mockImplementation(async () => null);

        await expect(getAddress({ id: "wallet" })).rejects.toMatchObject({
            message: "solana_balance_unavailable",
            status: 502,
        });
        expect(solanaSourceA.getAddress).toHaveBeenCalledTimes(1);
    });

    it("uses native RPC summary when scrapers report zero but RPC has SOL", async () => {
        solanaSourceA.getAddress.mockResolvedValueOnce(null);
        oklink.getAddress.mockResolvedValueOnce({ address: "wallet", balance: "0", tokenHoldings: { tokens: [] } });
        solanaSourceA.getNativeBalanceSummary.mockResolvedValueOnce({
            address: "wallet",
            balance: "2.5",
            tokenHoldings: { tokens: [{ amount: 2.5, symbol: "SOL" }] },
        });

        const result = await getAddress({ id: "wallet" });

        expect(result.balance).toBe("2.5");
        expect(result.source).toBe("sourceA_native");
        expect(result.tokensIncomplete).toBe(true);
        expect(solanaSourceA.getAddress).toHaveBeenCalledTimes(1);
        expect(solanaSourceA.getNativeBalanceSummary).toHaveBeenCalledTimes(1);
    });
});
