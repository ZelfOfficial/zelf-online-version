// enrichTxRows fills each signature row from getTransaction, caches the result and never
// holds the response past its deadline.
const mockPost = jest.fn();

jest.mock("../../Core/axios", () => ({ getCleanInstance: () => ({ post: (...args) => mockPost(...args) }) }));
jest.mock("../../Core/naas-gateway-catalog", () => ({
    getNaasNodeUrl: async () => "https://naas.example/solana",
    NAAS_CHAIN: { SOLANA: "solana" },
    refreshNaasCatalogAfterUnauthorized: jest.fn(),
    isNaasNodeUnauthorizedError: () => false,
}));
jest.mock("../../Repositories/binance/modules/binance.module", () => ({ getTickerPrice: async () => ({ price: "100" }) }));
jest.mock("../../Repositories/Solana/modules/jupiter-spl-metadata.module", () => ({ enrichSplTokenRowsWithJupiter: async () => {} }));

const zns = require("./fixtures/solana/zns-reward-in.json");
const QA99 = "E5zQvcpuRdtcwZfRxBKHLgnUQRf6wCsYBf75Lix5upEG";

const row = (hash) => ({ hash, traffic: "", amount: 0, asset: "SOL", from: "", to: QA99, status: "Success", fiatAmount: "0" });

describe("enrichTxRows", () => {
    let SourceA;

    beforeEach(() => {
        jest.useRealTimers();
        mockPost.mockReset();
        jest.spyOn(console, "warn").mockImplementation(() => {});
        jest.spyOn(console, "error").mockImplementation(() => {});
        jest.isolateModules(() => {
            SourceA = require("../../Repositories/Solana/modules/solana-source-a-rpc.module");
        });
    });

    afterEach(() => jest.restoreAllMocks());

    it("fills direction, amount and asset, and reuses the cached summary", async () => {
        mockPost.mockImplementation(async (url, body) => ({ data: { result: body.method === "getTransaction" ? zns : null } }));

        const [first] = await SourceA.enrichTxRows([row("sig1")], QA99);
        expect(first).toMatchObject({ traffic: "IN", amount: 10, asset: "ZNS", method: "transfer" });

        await SourceA.enrichTxRows([row("sig1")], QA99);
        expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it("keeps the bare row when the node errors, and skips failed transactions", async () => {
        mockPost.mockRejectedValue(new Error("boom"));
        const failed = { ...row("sig3"), status: "Failed" };

        const [bare, skipped] = await SourceA.enrichTxRows([row("sig2"), failed], QA99);

        expect(bare).toMatchObject({ traffic: "", amount: 0, asset: "SOL" });
        expect(skipped.traffic).toBe("");
        expect(mockPost.mock.calls.every(([, body]) => body.params[0] !== "sig3")).toBe(true);
    });

    it("returns by the deadline even if the node hangs", async () => {
        jest.useFakeTimers();
        mockPost.mockImplementation(() => new Promise(() => {}));

        let done = false;
        const pending = SourceA.enrichTxRows([row("a"), row("b")], QA99).then((rows) => {
            done = true;
            return rows;
        });

        await jest.advanceTimersByTimeAsync(3999);
        expect(done).toBe(false);
        await jest.advanceTimersByTimeAsync(10);
        const rows = await pending;
        expect(done).toBe(true);
        expect(rows.map((r) => r.amount)).toEqual([0, 0]);
    });
});
