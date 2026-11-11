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

