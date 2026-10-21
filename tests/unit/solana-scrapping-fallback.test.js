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
}));

const solscan = require("../../Repositories/Solana/modules/solscan");
const oklink = require("../../Repositories/Solana/modules/oklink");
const solanaSourceA = require("../../Repositories/Solana/modules/solana-source-a-rpc.module");
const { getAddress } = require("../../Repositories/Solana/modules/solana-scrapping.module");

describe("solana-scrapping getAddress", () => {
    beforeEach(() => {
        solscan.getAddress.mockClear();
        oklink.getAddress.mockClear();
        solanaSourceA.getAddress.mockClear();
    });

    it("falls back to sourceA RPC when scrapers return empty payloads", async () => {
        const result = await getAddress({ id: "wallet" });

        expect(result.source).toBe("sourceA");
        expect(result.balance).toBe("1.5");
        expect(solanaSourceA.getAddress).toHaveBeenCalled();
    });

    it("throws 502 when every upstream fails", async () => {
        solanaSourceA.getAddress.mockImplementation(async () => null);

        await expect(getAddress({ id: "wallet" })).rejects.toMatchObject({
            message: "solana_balance_unavailable",
            status: 502,
        });
    });
});
