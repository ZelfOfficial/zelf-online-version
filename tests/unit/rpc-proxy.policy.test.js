jest.mock("../../Core/axios", () => {
    const post = jest.fn();
    return { getCleanInstance: () => ({ post }) };
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
const { forwardRequest } = require("../../Repositories/RPC/modules/rpc.module");
const Middleware = require("../../Repositories/RPC/middlewares/rpc.middleware");

const ENV_KEYS = [
    "EXTENSION_ETHEREUM_RPC_URL",
    "EXTENSION_ETHEREUM_SEPOLIA_RPC_URL",
    "ETH_SEPOLIA_RPC_URL",
    "RPC_PROXY_ETHEREUM_SEPOLIA_URL",
    "EXTENSION_POLYGON_RPC_URL",
    "EXTENSION_AVALANCHE_RPC_URL",
    "EXTENSION_BSC_RPC_URL",
    "EXTENSION_ARBITRUM_RPC_URL",
    "EXTENSION_OPTIMISM_RPC_URL",
    "EXTENSION_BASE_RPC_URL",
    "EXTENSION_SOLANA_RPC_URL",
    "RPC_PROXY_MAX_BODY_BYTES",
    "RPC_PROXY_MAX_BATCH",
];

const savedEnv = {};

const chainCases = [
    ["ethereum", "EXTENSION_ETHEREUM_RPC_URL", "eth_chainId", []],
    ["ethereum-sepolia", "EXTENSION_ETHEREUM_SEPOLIA_RPC_URL", "eth_chainId", []],
    ["polygon", "EXTENSION_POLYGON_RPC_URL", "eth_getBalance", ["0x0000000000000000000000000000000000000001", "latest"]],
    ["avalanche", "EXTENSION_AVALANCHE_RPC_URL", "eth_chainId", []],
    ["bsc", "EXTENSION_BSC_RPC_URL", "eth_chainId", []],
    ["arbitrum", "EXTENSION_ARBITRUM_RPC_URL", "eth_chainId", []],
    ["optimism", "EXTENSION_OPTIMISM_RPC_URL", "eth_chainId", []],
    ["base", "EXTENSION_BASE_RPC_URL", "eth_chainId", []],
    ["solana", "EXTENSION_SOLANA_RPC_URL", "getBalance", ["11111111111111111111111111111111"]],
];

describe("RPC proxy policy", () => {
    const post = getCleanInstance().post;
    let infoSpy;

    beforeAll(() => {
        for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    });

    beforeEach(() => {
        post.mockReset();
        post.mockResolvedValue({ data: { jsonrpc: "2.0", id: 7, result: "0x1" } });
        RpcCaller.assertWithinRateLimit.mockClear();
        infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
        for (const [chain, envKey] of chainCases) {
            process.env[envKey] = `https://rpc.test/${chain}/secret-token-value`;
        }
    });

    afterEach(() => {
        infoSpy.mockRestore();
        for (const key of ENV_KEYS) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
    });

    it.each(chainCases)("forwards %s %s on the extension proxy", async (chain, _envKey, method, params) => {
        const result = await forwardRequest(
            { chain, method, params, rpcId: 7 },
            { ip: "203.0.113.10", authUser: { identifier: "device-1", session: "sess-1" } },
            { useExtensionRpc: true }
        );

        expect(result.result).toBe("0x1");
        expect(result.method).toBe(method);
        const upstream = String(post.mock.calls[0][0]);
        expect(upstream.includes(`/secret-token-value`)).toBe(true);
        expect(upstream.includes(`/${chain}/`)).toBe(true);
        expect(post.mock.calls[0][1]).toMatchObject({ method, id: 7 });
        expect(RpcCaller.assertWithinRateLimit).toHaveBeenCalledWith("203.0.113.10", { userKey: "device-1" });
        expect(infoSpy.mock.calls.map((call) => JSON.stringify(call)).join("\n")).not.toContain("secret-token-value");
    });

    it("accepts the sepolia alias", async () => {
        await forwardRequest({ chain: "sepolia", method: "eth_chainId", params: [] }, { ip: "203.0.113.10" }, { useExtensionRpc: true });
        expect(String(post.mock.calls[0][0]).includes("/ethereum-sepolia/")).toBe(true);
    });

    it("fails closed when a paid extension upstream is unset", async () => {
        delete process.env.EXTENSION_ETHEREUM_SEPOLIA_RPC_URL;
        delete process.env.ETH_SEPOLIA_RPC_URL;
        delete process.env.RPC_PROXY_ETHEREUM_SEPOLIA_URL;

        await expect(
            forwardRequest({ chain: "ethereum-sepolia", method: "eth_chainId", params: [] }, {}, { useExtensionRpc: true })
        ).rejects.toMatchObject({ status: 503, clientCode: "rpc_upstream_not_configured" });
        expect(post).not.toHaveBeenCalled();
    });

    it.each([
        ["debug_traceTransaction", "ethereum"],
        ["trace_block", "ethereum"],
        ["eth_subscribe", "ethereum"],
        ["eth_unsubscribe", "polygon"],
        ["eth_getLogs", "bsc"],
        ["eth_sendTransaction", "avalanche"],
        ["qn_getWalletTokenBalance", "ethereum"],
        ["alchemy_getTokenBalances", "ethereum"],
        ["getProgramAccounts", "solana"],
        ["requestAirdrop", "solana"],
        ["getBalance", "ethereum"],
        ["eth_chainId", "solana"],
    ])("rejects %s on %s", async (method, chain) => {
        await expect(forwardRequest({ chain, method, params: [] }, {}, { useExtensionRpc: true })).rejects.toMatchObject({
            status: 403,
            clientCode: "rpc_method_not_allowed",
        });
        expect(post).not.toHaveBeenCalled();
    });

    it("returns RESPONSE_TOO_LARGE when the JSON-RPC body exceeds the cap", async () => {
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
        post.mockRejectedValue(Object.assign(new Error("maxContentLength size of 2097152 exceeded"), {
            config: { url: "https://rpc.test/ethereum/secret-token-value" },
        }));

        await expect(
            forwardRequest({ chain: "ethereum", method: "eth_chainId", params: [] }, {}, { useExtensionRpc: true })
        ).rejects.toMatchObject({
            status: 413,
            clientCode: "RESPONSE_TOO_LARGE",
            message: "Upstream response is too large",
        });

        expect(warn).toHaveBeenCalledWith("[RPC proxy] upstream response too large", {
            chain: "ethereum",
            route: "eth_chainId",
        });
        expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-token-value");
        expect(post.mock.calls[0][2].maxContentLength).toBe(2 * 1024 * 1024);
        warn.mockRestore();
    });

    it("drops upstream errors that echo the provider URL", async () => {
        post.mockResolvedValue({
            data: { error: { code: -32000, message: "down https://rpc.test/ethereum/secret-token-value" } },
        });

        await expect(
            forwardRequest({ chain: "ethereum", method: "eth_chainId", params: [] }, {}, { useExtensionRpc: true })
        ).rejects.toMatchObject({
            status: 502,
            message: "RPC upstream request failed",
        });
    });

    it("rejects an oversized JSON-RPC batch", async () => {
        process.env.RPC_PROXY_MAX_BATCH = "2";
        const ctx = {
            request: {
                body: [1, 2, 3].map((id) => ({ jsonrpc: "2.0", id, method: "eth_chainId", params: [] })),
            },
            params: { chainKey: "ethereum" },
            get: () => "",
            status: 200,
            body: null,
        };

        const next = jest.fn();
        await Middleware.jsonRpcValidation(ctx, next);

        expect(next).not.toHaveBeenCalled();
        expect(ctx.status).toBe(413);
        expect(ctx.body.error.code).toBe(-32600);
    });

    it("rejects an oversized JSON-RPC body", async () => {
        process.env.RPC_PROXY_MAX_BODY_BYTES = "1024";
        const ctx = {
            request: { body: { jsonrpc: "2.0", id: 1, method: "eth_call", params: ["0x" + "ab".repeat(2000)] } },
            params: { chainKey: "ethereum" },
            get: () => "",
            status: 200,
            body: null,
        };

        const next = jest.fn();
        await Middleware.jsonRpcValidationExtension(ctx, next);

        expect(next).not.toHaveBeenCalled();
        expect(ctx.status).toBe(413);
    });
});
