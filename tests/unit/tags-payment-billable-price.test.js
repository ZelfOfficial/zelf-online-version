jest.mock("../../Repositories/Tags/config/supported-domains", () => ({
    getDomainConfig: jest.fn(),
    getDomainPrice: jest.fn(),
    getDomainPaymentMethods: jest.fn(),
    getDomainCurrencies: jest.fn(),
    getDomainLimits: jest.fn(),
}));

jest.mock("../../Repositories/Tags/modules/tags-ipfs.module", () => ({}));
jest.mock("../../Repositories/Tags/modules/tags-parts.module", () => ({}));
jest.mock("../../Repositories/Wallet/modules/eth", () => ({ createEthWallet: jest.fn() }));
jest.mock("../../Repositories/Wallet/modules/btc", () => ({ createBTCWallet: jest.fn() }));
jest.mock("../../Repositories/Wallet/modules/solana", () => ({ createSolanaWallet: jest.fn() }));
jest.mock("../../Repositories/Wallet/modules/helpers", () => ({ generateMnemonic: jest.fn() }));
jest.mock("../../Repositories/Tags/modules/tags.module", () => ({ searchTag: jest.fn() }));
jest.mock("../../Repositories/binance/modules/binance.module", () => ({ getTickerPrice: jest.fn() }));
jest.mock("jsonwebtoken", () => ({ sign: jest.fn(), verify: jest.fn() }));
jest.mock("../../Repositories/Tags/modules/tag-pay-usdc.util", () => ({
    usdcAtomicFromUsd: jest.fn(),
    stableAtomicFromUsd: jest.fn(),
}));
jest.mock("../../Core/config", () => ({ env: "test" }));
jest.mock("../../Repositories/Walrus/modules/walrus.module", () => ({}));
jest.mock("../../Repositories/Tags/modules/tags-arweave.module", () => ({}));
jest.mock("../../Repositories/Tags/modules/qr-zelfproof-extractor.module", () => ({
    generateQRFromZelfProof: jest.fn(),
    QRZelfProofExtractor: jest.fn(),
}));

const { roundBillableUsdPrice } = require("../../Repositories/Tags/modules/tags-payment.module");

const { parseUnits, formatEther } = require("ethers");

describe("roundBillableUsdPrice", () => {
    it("rounds noisy floating-point values to the nearest cent", () => {
        expect(roundBillableUsdPrice(0.3999999999999976)).toBe(0.4);
        expect(roundBillableUsdPrice(1.1999999999999993)).toBe(1.2);
    });

    it("preserves clean cent values and clamps invalid negatives", () => {
        expect(roundBillableUsdPrice(0.02)).toBe(0.02);
        expect(roundBillableUsdPrice(-0.01)).toBe(0);
    });
});

describe("native wei precision via a string token price", () => {
    const WAD = BigInt(10) ** BigInt(18);

    it("produces exact 0.4 tokens when billableUsd=0.02 and tokenPrice='0.05' (string)", () => {
        const usdScaled = parseUnits("0.02", 18);
        const pxScaled = parseUnits("0.05", 18);
        const wei = (usdScaled * WAD) / pxScaled;
        expect(formatEther(wei)).toBe("0.4");
    });

    it("would produce 0.399999999999999976 with a float 0.05 through toFixed(18)", () => {
        const badStr = (0.05).toFixed(18).replace(/\.?0+$/, "");
        expect(badStr).toBe("0.050000000000000003");
        const usdScaled = parseUnits("0.02", 18);
        const pxScaled = parseUnits(badStr, 18);
        const wei = (usdScaled * WAD) / pxScaled;
        expect(formatEther(wei)).toBe("0.399999999999999976");
    });
});
