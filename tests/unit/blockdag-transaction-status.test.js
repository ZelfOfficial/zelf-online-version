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

// Keep this file's config load from re-applying .env over the overrides under test.
jest.mock("dotenv", () => ({ config: jest.fn(() => ({})) }));

jest.mock("../../Repositories/binance/modules/binance.module", () => ({ getTickerPrice: jest.fn() }));

const HASH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FROM = "0x1111111111111111111111111111111111111111";
const TO = "0x2222222222222222222222222222222222222222";
const ADDRESS = "0x1BC125bC681685f216935798453F70fb423eB392";
const EAST_RPC = "https://rpc.east.bdag-us.org";

const RPC_ENV_KEYS = [
    "BLOCKDAG_RPC_URL",
    "BLOCKDAG_MAIN_RPC_URL",
    "BLOCKDAG_NOW_NODES_API_KEY",
    "BLOCKDAG_RPC_FALLBACK_URLS",
    "EXTENSION_BLOCKDAG_RPC_URL",
    "RPC_PROXY_BLOCKDAG_URL",
    "BLOCKDAG_CHAIN_ID",
];

const savedEnv = {};

const explorerDown = () => {
    const error = new Error("origin error");
    error.response = { status: 530 };
    mockGet.mockRejectedValue(error);
};

const txResult = (blockNumber) => ({
    hash: HASH,
    from: FROM,
    to: TO,
    value: "0x38d7ea4c68000",
    gas: "0x5208",
    gasPrice: "0x3b9aca00",
    nonce: "0x2",
    input: "0x",
    blockNumber,
    transactionIndex: blockNumber ? "0x3" : null,
});

const rpcByMethod = (tx, receipt) => async (_url, body) => {
    if (body.method === "eth_getTransactionByHash") {
        return { data: { jsonrpc: "2.0", id: 1, result: tx } };
    }
    if (body.method === "eth_getTransactionReceipt") {
        return { data: { jsonrpc: "2.0", id: 1, result: receipt } };
    }
    return { data: { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not found" } } };
};

describe("BlockDAG transaction status RPC fallback", () => {
    let getTransactionStatus;

    beforeAll(() => {
        for (const key of RPC_ENV_KEYS) savedEnv[key] = process.env[key];
    });

    beforeEach(() => {
        mockGet.mockReset();
        mockPost.mockReset();
        for (const key of RPC_ENV_KEYS) delete process.env[key];
        jest.spyOn(console, "warn").mockImplementation(() => {});
        jest.spyOn(console, "log").mockImplementation(() => {});
        jest.spyOn(console, "error").mockImplementation(() => {});
        jest.isolateModules(() => {
            ({ getTransactionStatus } = require("../../Repositories/BlockDAG/modules/blockdag.module"));
        });
    });

    afterEach(() => {
        for (const key of RPC_ENV_KEYS) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
        jest.restoreAllMocks();
    });

    it("reports pending when the explorer is down and the transaction is not mined", async () => {
        explorerDown();
        mockPost.mockImplementation(rpcByMethod(txResult(null), null));

        const result = await getTransactionStatus({ id: HASH, address: ADDRESS });

        expect(result.status).toBe("pending");
        expect(result.error).toBeUndefined();
        expect(result.confirmations).toBe("0");
        expect(result.blockNumber).toBe("N/A");
        expect(result.hash).toBe(HASH);
        expect(result.from).toBe(FROM);
        expect(result.to).toBe(TO);
        expect(String(mockPost.mock.calls[0][0]).replace(/\/$/, "")).toBe(EAST_RPC);
    });

    it("reports success when the explorer is down and the receipt is confirmed", async () => {
        explorerDown();
        mockPost.mockImplementation(
            rpcByMethod(txResult("0x10"), {
                status: "0x1",
                gasUsed: "0x5208",
                blockNumber: "0x10",
                transactionHash: HASH,
            })
        );

        const result = await getTransactionStatus({ id: HASH, address: ADDRESS });

        expect(result.status).toBe("success");
        expect(result.error).toBeUndefined();
        expect(result.confirmations).toBe("1");
        expect(result.blockNumber).toBe(16);
        expect(result.gasUsed).toBe(21000);
        expect(result.transactionIndex).toBe(3);
    });

    it("reports failed when the explorer is down and the receipt status is 0x0", async () => {
        explorerDown();
        mockPost.mockImplementation(
            rpcByMethod(txResult("0x11"), {
                status: "0x0",
                gasUsed: "0x7530",
                blockNumber: "0x11",
                transactionHash: HASH,
            })
        );

        const result = await getTransactionStatus({ id: HASH, address: ADDRESS });

        expect(result.status).toBe("failed");
        expect(result.error).toBeUndefined();
        expect(result.blockNumber).toBe(17);
        expect(result.confirmations).toBe("1");
    });

    it("returns TRANSACTION_STATUS_UNAVAILABLE when the explorer and every RPC fail", async () => {
        explorerDown();
        mockPost.mockResolvedValue({ data: { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "down" } } });

        const result = await getTransactionStatus({ id: HASH, address: ADDRESS });

        expect(result).toMatchObject({ error: "TRANSACTION_STATUS_UNAVAILABLE", status: "error", hash: HASH });
    });

    it("posts to BLOCKDAG_RPC_URL when that env var overrides the default", async () => {
        process.env.BLOCKDAG_RPC_URL = "https://rpc.override.test/bdag";
        jest.isolateModules(() => {
            ({ getTransactionStatus } = require("../../Repositories/BlockDAG/modules/blockdag.module"));
        });
        explorerDown();
        mockPost.mockImplementation(rpcByMethod(txResult(null), null));

        const result = await getTransactionStatus({ id: HASH, address: ADDRESS });

        expect(result.status).toBe("pending");
        expect(String(mockPost.mock.calls[0][0]).replace(/\/$/, "")).toBe("https://rpc.override.test/bdag");
    });
});

describe("BlockDAG RPC defaults", () => {
    beforeAll(() => {
        for (const key of RPC_ENV_KEYS) savedEnv[key] = process.env[key];
    });

    beforeEach(() => {
        for (const key of RPC_ENV_KEYS) delete process.env[key];
    });

    afterEach(() => {
        for (const key of RPC_ENV_KEYS) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
    });

    it("uses rpc.east.bdag-us.org on chain 1404 unless env vars override it", () => {
        jest.isolateModules(() => {
            const config = require("../../Core/config");
            const { CHAIN_SPECS, legacyChains, extensionChains } = require("../../Core/rpc-upstreams");
            const spec = CHAIN_SPECS.find((item) => item.key === "blockdag");

            expect(config.blockdag.rpcUrl).toBe(EAST_RPC);
            expect(config.blockdag.mainRpcUrl).toBe(EAST_RPC);
            expect(config.blockdag.chainId).toBe(1404);
            expect(spec.publicUrl).toBe(EAST_RPC);
            expect(spec.chainId()).toBe(1404);
            expect(legacyChains().blockdag.rpcUrl).toBe(EAST_RPC);
            expect(extensionChains().blockdag.rpcUrl).toBe(EAST_RPC);
        });
    });

    it("lets BLOCKDAG_RPC_URL and BLOCKDAG_MAIN_RPC_URL override the public RPC", () => {
        process.env.BLOCKDAG_RPC_URL = "https://rpc.override.test/bdag";
        process.env.BLOCKDAG_MAIN_RPC_URL = "https://rpc.main.override.test/bdag";

        jest.isolateModules(() => {
            const config = require("../../Core/config");
            const { legacyChains } = require("../../Core/rpc-upstreams");

            expect(config.blockdag.rpcUrl).toBe("https://rpc.override.test/bdag");
            expect(config.blockdag.mainRpcUrl).toBe("https://rpc.main.override.test/bdag");
            expect(legacyChains().blockdag.rpcUrl).toBe("https://rpc.main.override.test/bdag");
        });
    });
});
