const fs = require("fs");
const path = require("path");

const FILES = [
    "Core/config.js",
    "Core/rpc-upstreams.js",
    "Repositories/Avalanche/modules/avax-nft.module.js",
    "Avalanche/hardhat.config.js",
    "Avalanche/modules/avalanche-nft.module.js",
    "Repositories/RPC/modules/rpc.module.js",
    "Repositories/RPC/modules/rpc-rest.module.js",
    "Repositories/Solana/modules/solana-source-a-rpc.module.js",
];

describe("RPC upstreams are not hardcoded", () => {
    it("does not embed a filled provider URL", () => {
        for (const file of FILES) {
            const source = fs.readFileSync(path.resolve(__dirname, "../../", file), "utf8");
            expect(source).not.toMatch(/quiknode\.pro\/[A-Za-z0-9]{16,}/);
            expect(source).not.toMatch(/quicknode\.pro\/[A-Za-z0-9]{16,}/);
            expect(source).not.toMatch(/fragrant-wild-smoke|flashy-ultra-choice/);
        }
    });
});
