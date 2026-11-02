jest.mock("../../Core/axios", () => {
    const request = jest.fn();
    return { getCleanInstance: () => ({ request }) };
});

jest.mock("../../Repositories/RPC/models/rpc-log.model", () => ({
    create: jest.fn(async () => ({})),
}));

jest.mock("../../Repositories/RPCCaller/modules/rpc-caller.module", () => ({
    assertNotBanned: jest.fn(async () => {}),
    assertWithinRateLimit: jest.fn(async () => {}),
    recordRequest: jest.fn(),
}));

const { getCleanInstance } = require("../../Core/axios");
const RpcCaller = require("../../Repositories/RPCCaller/modules/rpc-caller.module");
const { proxyBitcoin, proxyStellar } = require("../../Repositories/RPC/modules/rpc-rest.module");

const ENV_KEYS = [
    "EXTENSION_BTC_MAINNET_RPC_URL",
    "EXTENSION_BTC_TESTNET_RPC_URL",
    "BTC_MAINNET_BLOCKBOOK_URL",
    "BTC_TESTNET_BLOCKBOOK_URL",
    "EXTENSION_STELLAR_HORIZON_URL",
];
const saved = {};
const ADDRESS = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const TXID = "11".repeat(32);
const ACCOUNT = `G${"A".repeat(55)}`;

describe("bitcoin and stellar RPC proxy", () => {
    const request = getCleanInstance().request;

    beforeAll(() => {
        for (const key of ENV_KEYS) saved[key] = process.env[key];
    });

    beforeEach(() => {
        request.mockReset();
        RpcCaller.assertWithinRateLimit.mockClear();
        process.env.EXTENSION_BTC_MAINNET_RPC_URL = "https://blockbook.test/mainnet/secret-token-value";
        process.env.EXTENSION_BTC_TESTNET_RPC_URL = "https://blockbook.test/testnet/secret-token-value";
        process.env.EXTENSION_STELLAR_HORIZON_URL = "https://horizon.test/secret-token-value";
    });

    afterEach(() => {
        for (const key of ENV_KEYS) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    });

    it("fails closed when bitcoin or stellar upstreams are unset", async () => {
        delete process.env.EXTENSION_BTC_MAINNET_RPC_URL;
        delete process.env.BTC_MAINNET_BLOCKBOOK_URL;
        delete process.env.EXTENSION_STELLAR_HORIZON_URL;

        await expect(proxyBitcoin({ network: "mainnet", operation: "utxo", address: ADDRESS })).rejects.toMatchObject({
            status: 503,
            clientCode: "rpc_upstream_not_configured",
        });
        await expect(proxyStellar({ operation: "fee_stats" })).rejects.toMatchObject({
            status: 503,
            clientCode: "rpc_upstream_not_configured",
        });
        expect(request).not.toHaveBeenCalled();
    });

    it("proxies a mainnet UTXO read and a testnet raw tx", async () => {
        request.mockResolvedValueOnce({ status: 200, headers: { "content-type": "application/json" }, data: [{ txid: TXID, vout: 0, value: "10" }] });
        const utxo = await proxyBitcoin({
            network: "mainnet",
            operation: "utxo",
            address: ADDRESS,
            query: {},
            authUser: { identifier: "device-1" },
            ip: "203.0.113.8",
        });
        expect(utxo.body).toEqual([{ txid: TXID, vout: 0, value: "10" }]);
        expect(String(request.mock.calls[0][0].url).includes("/api/v2/utxo/")).toBe(true);
        expect(String(request.mock.calls[0][0].url).includes("secret-token-value")).toBe(true);
        expect(RpcCaller.assertWithinRateLimit).toHaveBeenCalledWith("203.0.113.8", { userKey: "device-1" });

        request.mockResolvedValueOnce({
            status: 200,
            headers: { "content-type": "application/json" },
            data: { hex: "abcd" },
        });
        const hex = await proxyBitcoin({ network: "testnet", operation: "tx-hex", txid: TXID, query: {} });
        expect(hex).toMatchObject({ status: 200, body: "abcd" });
        expect(String(request.mock.calls[1][0].url).includes("/testnet/")).toBe(true);
    });

    it("broadcasts a raw bitcoin transaction as text and returns the txid", async () => {
        request.mockResolvedValue({
            status: 200,
            headers: { "content-type": "application/json" },
            data: { result: TXID },
        });
        const raw = "ab".repeat(40);
        const result = await proxyBitcoin({ network: "mainnet", operation: "broadcast", body: { hex: raw }, query: {} });
        expect(result).toMatchObject({ status: 200, body: TXID });
        expect(request.mock.calls[0][0].data).toBe(raw);
        expect(request.mock.calls[0][0].headers["Content-Type"]).toBe("text/plain");
    });

    it("rejects bitcoin paths and methods outside the allowlist", async () => {
        await expect(proxyBitcoin({ network: "regtest", operation: "utxo", address: ADDRESS })).rejects.toMatchObject({ status: 404 });
        await expect(proxyBitcoin({ network: "mainnet", operation: "utxo", address: "../etc/passwd" })).rejects.toMatchObject({
            status: 400,
        });
        await expect(proxyBitcoin({ network: "mainnet", operation: "admin", address: ADDRESS })).rejects.toMatchObject({ status: 404 });
        expect(request).not.toHaveBeenCalled();
    });

    it("proxies the Horizon calls the extension wallet uses", async () => {
        request.mockResolvedValue({ status: 200, headers: { "content-type": "application/json" }, data: { records: [] } });

        await proxyStellar({ operation: "fee_stats", authUser: { identifier: "device-2" }, ip: "198.51.100.4" });
        await proxyStellar({ operation: "ledgers", query: { order: "desc", limit: "1", cursor: "now", drop: "this" } });
        await proxyStellar({ operation: "account", accountId: ACCOUNT });
        await proxyStellar({ operation: "submit", body: { tx: "A".repeat(80) } });

        const urls = request.mock.calls.map((call) => String(call[0].url));
        expect(urls[0].endsWith("/fee_stats")).toBe(true);
        expect(urls[1].endsWith("/ledgers")).toBe(true);
        expect(request.mock.calls[1][0].params).toEqual({ order: "desc", limit: 1, cursor: "now" });
        expect(urls[2].includes(`/accounts/${ACCOUNT}`)).toBe(true);
        expect(urls[3].endsWith("/transactions")).toBe(true);
        expect(request.mock.calls[3][0].headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
        expect(String(request.mock.calls[3][0].data).startsWith("tx=")).toBe(true);
        expect(urls.join("\n")).toContain("secret-token-value");
        expect(RpcCaller.assertWithinRateLimit).toHaveBeenCalledWith("198.51.100.4", { userKey: "device-2" });
    });

    it("passes through a Horizon 404 and hides upstream URLs in error bodies", async () => {
        request.mockResolvedValueOnce({
            status: 404,
            headers: { "content-type": "application/json" },
            data: { type: "https://stellar.org/horizon-errors/not_found", status: 404 },
        });
        const missing = await proxyStellar({ operation: "account", accountId: ACCOUNT });
        expect(missing.status).toBe(404);
        expect(missing.body.status).toBe(404);

        request.mockResolvedValueOnce({
            status: 500,
            headers: { "content-type": "application/json" },
            data: { detail: "https://horizon.test/secret-token-value failed" },
        });
        const leaked = await proxyStellar({ operation: "fee_stats" });
        expect(leaked.body).toEqual({ error: "upstream_error" });
        expect(JSON.stringify(leaked.body)).not.toContain("secret-token-value");
    });
});
