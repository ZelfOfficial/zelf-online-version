const Module = require("../../Repositories/RPC/modules/rpc.module");

describe("rpc.module", () => {
    it("lists configured chains", () => {
        const chains = Module.getChains();

        expect(Array.isArray(chains)).toBe(true);
        expect(chains.some((chain) => chain.chain === "ethereum" && chain.chainId === 1)).toBe(true);
        expect(chains.some((chain) => chain.chain === "sui" && chain.chainId === 101)).toBe(true);
        expect(chains.some((chain) => chain.chain === "blockdag" || chain.chainId === 1404)).toBe(false);
    });

    it("rejects blocked subscription methods", async () => {
        await expect(
            Module.forwardRequest({
                chain: "ethereum",
                method: "eth_subscribe",
                params: ["newHeads"],
            })
        ).rejects.toMatchObject({
            status: 403,
        });
    });

    it("rejects unknown chains", async () => {
        await expect(
            Module.forwardRequest({
                chain: "unknown-chain",
                method: "eth_blockNumber",
                params: [],
            })
        ).rejects.toMatchObject({
            status: 400,
        });
    });

    it("rejects a retired chain with UNSUPPORTED_CHAIN", async () => {
        await expect(
            Module.forwardRequest({
                chain: "blockdag",
                method: "eth_blockNumber",
                params: [],
            })
        ).rejects.toMatchObject({
            status: 400,
            clientCode: "UNSUPPORTED_CHAIN",
        });

        await expect(
            Module.forwardRequest({
                chainId: 1404,
                method: "eth_blockNumber",
                params: [],
            })
        ).rejects.toMatchObject({
            status: 400,
            clientCode: "UNSUPPORTED_CHAIN",
        });
    });
});
