const { errorHandler } = require("../../Core/http-handler");
const {
    assertSupportedChain,
    assertSupportedDomain,
    isUnsupportedChain,
    isUnsupportedDomain,
    unsupportedChainError,
    unsupportedDomainError,
} = require("../../Core/unsupported-networks");
const { filterOfferedDomains } = require("../../Repositories/Tags/modules/domain.class");

const priced = (name) => ({
    name,
    tags: { payment: { planPricing: { premium: { "6-15": { 1: 1 } } }, currencies: ["ETH", "BDAG"], networks: { ethereum: { enabled: true }, blockdag: { enabled: true } } } },
});

describe("removed chain and domain", () => {
    test("domain and chain identifiers are recognized", () => {
        expect(isUnsupportedDomain("bdag")).toBe(true);
        expect(isUnsupportedDomain("alice.bdag")).toBe(true);
        expect(isUnsupportedDomain("alice.bdag.hold")).toBe(true);
        expect(isUnsupportedDomain("bdagpay")).toBe(true);
        expect(isUnsupportedDomain("zelf")).toBe(false);
        expect(isUnsupportedChain("blockdag")).toBe(true);
        expect(isUnsupportedChain("BDAG")).toBe(true);
        expect(isUnsupportedChain("BLOCKDAG_SC")).toBe(true);
        expect(isUnsupportedChain(1404)).toBe(true);
        expect(isUnsupportedChain("ethereum")).toBe(false);
    });

    test("shared requests get HTTP 400 codes", () => {
        const domain = errorHandler(unsupportedDomainError());
        const chain = errorHandler(unsupportedChainError());
        expect(domain).toMatchObject({ status: 400, code: "UNSUPPORTED_DOMAIN", message: "UNSUPPORTED_DOMAIN" });
        expect(chain).toMatchObject({ status: 400, code: "UNSUPPORTED_CHAIN", message: "UNSUPPORTED_CHAIN" });
        expect(() => assertSupportedDomain("zelf")).not.toThrow();
        expect(() => assertSupportedDomain("bdag")).toThrow(/400:UNSUPPORTED_DOMAIN/);
        expect(() => assertSupportedChain("ETH")).not.toThrow();
        expect(() => assertSupportedChain("blockdag")).toThrow(/400:UNSUPPORTED_CHAIN/);
    });

    test("public domain lists omit the domain and its payment method", () => {
        const offered = filterOfferedDomains({ zelf: priced("zelf"), bdag: priced("bdag") });
        expect(Object.keys(offered)).toEqual(["zelf"]);
        expect(offered.zelf.tags.payment.currencies).toEqual(["ETH"]);
        expect(offered.zelf.tags.payment.networks.blockdag).toBeUndefined();
        expect(offered.zelf.tags.payment.networks.ethereum).toEqual({ enabled: true });
        expect(priced("zelf").tags.payment.currencies).toEqual(["ETH", "BDAG"]);
    });
});
