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
const { UPSTREAM_RESPONSE_MAX_BYTES } = require("../../Core/rpc-upstreams");
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

    it("returns RESPONSE_TOO_LARGE when a Blockbook body exceeds the cap", async () => {
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
        const tooLarge = Object.assign(new Error(`maxContentLength size of ${UPSTREAM_RESPONSE_MAX_BYTES} exceeded`), {
            code: "ERR_BAD_RESPONSE",
            config: { url: "https://blockbook.test/mainnet/secret-token-value/api/v2/utxo/1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa" },
        });
        request.mockRejectedValue(tooLarge);

        await expect(
            proxyBitcoin({
                network: "mainnet",
                operation: "utxo",
                address: ADDRESS,
                query: {},
            })
        ).rejects.toMatchObject({
            status: 413,
            clientCode: "RESPONSE_TOO_LARGE",
            message: "Upstream response is too large",
        });

        expect(request.mock.calls[0][0].maxContentLength).toBe(2 * 1024 * 1024);
        expect(warn).toHaveBeenCalledWith("[RPC proxy] upstream response too large", {
            chain: "btc",
            route: "GET /btc/:network/address/:address/utxo",
        });
        expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-token-value");
        expect(JSON.stringify(warn.mock.calls)).not.toContain("http");
        warn.mockRestore();
    });

    it("keeps other upstream failures as rpc_upstream_failed", async () => {
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
        request.mockRejectedValue(new Error("socket hang up"));

        await expect(proxyBitcoin({ network: "mainnet", operation: "utxo", address: ADDRESS, query: {} })).rejects.toMatchObject({
            status: 502,
            clientCode: "rpc_upstream_failed",
        });
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
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

    describe("Horizon _links that point at the upstream", () => {
        const UPSTREAM = "https://example.stellar-mainnet.quiknode.pro/abcdefghijklmnopqrstuvwxyz012345";
        const abs = (path) => `${UPSTREAM}${path}`;
        const TX_HASH = "ab".repeat(32);

        const assertNoUpstream = (body) => {
            const text = JSON.stringify(body);
            expect(text).not.toContain("quiknode");
            expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
            expect(text).not.toContain("example.stellar-mainnet");
        };

        beforeEach(() => {
            process.env.EXTENSION_STELLAR_HORIZON_URL = UPSTREAM;
        });

        it("returns a ledgers page with base reserve and relative links", async () => {
            request.mockResolvedValue({
                status: 200,
                headers: { "content-type": "application/json" },
                data: {
                    _links: {
                        self: { href: abs("/ledgers?order=desc&limit=1") },
                        next: { href: abs("/ledgers?order=desc&limit=1&cursor=123") },
                        prev: { href: abs("/ledgers?order=asc&limit=1&cursor=123") },
                    },
                    _embedded: {
                        records: [
                            {
                                _links: { self: { href: abs("/ledgers/123") } },
                                sequence: 123,
                                base_reserve_in_stroops: 5000000,
                            },
                        ],
                    },
                },
            });

            const result = await proxyStellar({ operation: "ledgers", query: { order: "desc", limit: "1" } });

            expect(result.status).toBe(200);
            expect(result.body._embedded.records[0].base_reserve_in_stroops).toBe(5000000);
            expect(result.body._links.self.href).toBe("/ledgers?order=desc&limit=1");
            expect(result.body._embedded.records[0]._links.self.href).toBe("/ledgers/123");
            assertNoUpstream(result.body);
        });

        it("returns an account loadAccount needs, with relative links", async () => {
            request.mockResolvedValue({
                status: 200,
                headers: { "content-type": "application/json" },
                data: {
                    _links: {
                        self: { href: abs(`/accounts/${ACCOUNT}`) },
                        transactions: {
                            href: abs(`/accounts/${ACCOUNT}/transactions{?cursor,limit,order}`),
                            templated: true,
                        },
                    },
                    id: ACCOUNT,
                    account_id: ACCOUNT,
                    sequence: "998877665544",
                    balances: [{ balance: "10.0000000", asset_type: "native" }],
                },
            });

            const result = await proxyStellar({ operation: "account", accountId: ACCOUNT });

            expect(result.status).toBe(200);
            expect(result.body.sequence).toBe("998877665544");
            expect(result.body.balances[0].balance).toBe("10.0000000");
            expect(result.body.account_id).toBe(ACCOUNT);
            expect(result.body._links.self.href).toBe(`/accounts/${ACCOUNT}`);
            expect(result.body._links.transactions.templated).toBe(true);
            assertNoUpstream(result.body);
        });

        it("returns the Horizon root document with relative links", async () => {
            request.mockResolvedValue({
                status: 200,
                headers: { "content-type": "application/json" },
                data: {
                    _links: {
                        self: { href: `${UPSTREAM}/` },
                        account: { href: abs("/accounts/{account_id}"), templated: true },
                        ledgers: { href: abs("/ledgers{?cursor,limit,order}"), templated: true },
                        docs: { href: "https://stellar.org/horizon" },
                    },
                    horizon_version: "2.31.0",
                    network_passphrase: "Public Global Stellar Network ; September 2015",
                },
            });

            const result = await proxyStellar({ operation: "root" });

            expect(result.status).toBe(200);
            expect(result.body.horizon_version).toBe("2.31.0");
            expect(result.body.network_passphrase).toContain("Public Global Stellar Network");
            expect(result.body._links.self.href).toBe("/");
            expect(result.body._links.account.href).toBe("/accounts/{account_id}");
            expect(result.body._links.docs.href).toBe("https://stellar.org/horizon");
            assertNoUpstream(result.body);
        });

        it("returns a transaction submit result with a relative link", async () => {
            request.mockResolvedValue({
                status: 200,
                headers: { "content-type": "application/hal+json" },
                data: {
                    _links: { transaction: { href: abs(`/transactions/${TX_HASH}`) } },
                    hash: TX_HASH,
                    ledger: 456,
                    envelope_xdr: "AAAA",
                    result_xdr: "AAAA",
                },
            });

            const result = await proxyStellar({ operation: "submit", body: { tx: "A".repeat(80) } });

            expect(result.status).toBe(200);
            expect(result.body.hash).toBe(TX_HASH);
            expect(result.body.ledger).toBe(456);
            expect(result.body.envelope_xdr).toBe("AAAA");
            expect(result.body._links.transaction.href).toBe(`/transactions/${TX_HASH}`);
            assertNoUpstream(result.body);
        });

        it("still replaces a body that leaks the upstream outside _links", async () => {
            request.mockResolvedValue({
                status: 500,
                headers: { "content-type": "application/json" },
                data: {
                    _links: { self: { href: abs("/fee_stats") } },
                    detail: `failed at ${UPSTREAM}/internal`,
                },
            });

            const result = await proxyStellar({ operation: "fee_stats" });

            expect(result.status).toBe(500);
            expect(result.body).toEqual({ error: "upstream_error" });
            expect(JSON.stringify(result.body)).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
            expect(JSON.stringify(result.body)).not.toContain("quiknode");
        });
    });
});
