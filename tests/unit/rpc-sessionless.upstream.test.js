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
    assertWithinSessionlessRateLimit: jest.fn(async () => {}),
    recordRequest: jest.fn(),
}));

const { getCleanInstance } = require("../../Core/axios");
const { forwardSessionlessCall } = require("../../Repositories/RPC/modules/rpc.module");

const PAID = "https://rpc.test/ethereum/secret-token-value";

describe("sessionless RPC upstreams", () => {
    const post = getCleanInstance().post;
    const savedPaid = process.env.EXTENSION_ETHEREUM_RPC_URL;
    let infoSpy;
    let warnSpy;
    let errorSpy;

    beforeEach(() => {
        process.env.EXTENSION_ETHEREUM_RPC_URL = PAID;
        post.mockReset();
        post.mockResolvedValue({ data: { jsonrpc: "2.0", id: 1, result: "0x1" } });
        infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
        warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
        errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        infoSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
        if (savedPaid === undefined) delete process.env.EXTENSION_ETHEREUM_RPC_URL;
        else process.env.EXTENSION_ETHEREUM_RPC_URL = savedPaid;
    });

    const logged = () => JSON.stringify([...infoSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]);

    it("sends a read to the public endpoint", async () => {
        const result = await forwardSessionlessCall({
            chain: "ethereum",
            method: "eth_chainId",
            params: [],
            rpcId: 4,
            ip: "203.0.113.10",
        });

        expect(result.result).toBe("0x1");
        expect(post).toHaveBeenCalledTimes(1);
        expect(post.mock.calls[0][0]).toBe("https://eth.llamarpc.com");
        expect(post.mock.calls[0][1]).toMatchObject({ method: "eth_chainId", id: 4 });
        expect(logged()).not.toContain("secret-token-value");
    });

    it("falls back to the paid URL when the public endpoint is unavailable", async () => {
        post.mockRejectedValueOnce(new Error("timeout of 45000ms exceeded"));
        post.mockResolvedValueOnce({ data: { jsonrpc: "2.0", id: 1, result: "0x2" } });

        const result = await forwardSessionlessCall({
            chain: "ethereum",
            method: "eth_getBalance",
            params: ["0x0000000000000000000000000000000000000001", "latest"],
            ip: "203.0.113.10",
        });

        expect(result.result).toBe("0x2");
        expect(post.mock.calls.map((call) => call[0])).toEqual(["https://eth.llamarpc.com", PAID]);
        expect(logged()).not.toContain("secret-token-value");
    });

    it("uses the paid URL for eth_estimateGas and eth_sendRawTransaction", async () => {
        await forwardSessionlessCall({
            chain: "ethereum",
            method: "eth_estimateGas",
            params: [{ to: "0x0000000000000000000000000000000000000001" }],
            ip: "203.0.113.10",
        });
        await forwardSessionlessCall({
            chain: "ethereum",
            method: "eth_sendRawTransaction",
            params: ["0x02"],
            ip: "203.0.113.10",
        });

        expect(post.mock.calls.map((call) => call[0])).toEqual([PAID, PAID]);
        expect(logged()).not.toContain("secret-token-value");
    });

    it("does not fall back when the public node returns a JSON-RPC error", async () => {
        post.mockResolvedValueOnce({
            data: { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "execution reverted" } },
        });

        await expect(
            forwardSessionlessCall({
                chain: "ethereum",
                method: "eth_call",
                params: [],
                ip: "203.0.113.10",
            })
        ).rejects.toMatchObject({
            status: 502,
            clientCode: "RPC_UPSTREAM_ERROR",
            message: "execution reverted",
        });
        expect(post).toHaveBeenCalledTimes(1);
    });

    it("rejects eth_getLogs outside the block span before calling upstream", async () => {
        await expect(
            forwardSessionlessCall({
                chain: "ethereum",
                method: "eth_getLogs",
                params: [
                    {
                        address: "0x0000000000000000000000000000000000000001",
                        fromBlock: "0x1",
                        toBlock: "0x1000",
                    },
                ],
                ip: "203.0.113.10",
            })
        ).rejects.toMatchObject({ status: 400, clientCode: "RPC_SESSIONLESS_LOG_RANGE" });
        expect(post).not.toHaveBeenCalled();
    });

    it("hides a provider URL that comes back in an upstream error", async () => {
        post.mockResolvedValueOnce({
            data: { error: { code: -32000, message: `down ${PAID}` } },
        });

        await expect(
            forwardSessionlessCall({
                chain: "ethereum",
                method: "eth_estimateGas",
                params: [],
                ip: "203.0.113.10",
            })
        ).rejects.toMatchObject({
            status: 502,
            message: "RPC upstream request failed",
        });
        expect(logged()).not.toContain("secret-token-value");
    });
});
