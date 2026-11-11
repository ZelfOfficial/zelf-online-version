const {
    isRemovedDomain,
    isRemovedChain,
    isRemovedRecordKey,
    omitRemovedDomain,
    stripRemovedPayment,
} = require("../../Core/removed-blockdag");

describe("removed BlockDAG identifiers", () => {
    it("recognizes retired domains and leaves other domains alone", () => {
        expect(isRemovedDomain("bdag")).toBe(true);
        expect(isRemovedDomain(".bdag")).toBe(true);
        expect(isRemovedDomain("BDAGPAY")).toBe(true);
        expect(isRemovedDomain("zelf")).toBe(false);
        expect(isRemovedDomain("avax")).toBe(false);
    });

    it("recognizes retired chains and chain id 1404 only when no other chain is named", () => {
        expect(isRemovedChain("BDAG")).toBe(true);
        expect(isRemovedChain("blockdag")).toBe(true);
        expect(isRemovedChain("BLOCKDAG_SC")).toBe(true);
        expect(isRemovedChain(undefined, 1404)).toBe(true);
        expect(isRemovedChain("ethereum", 1404)).toBe(false);
        expect(isRemovedChain("avalanche", 43114)).toBe(false);
        expect(isRemovedRecordKey("john4_bdag")).toBe(true);
        expect(isRemovedRecordKey("migueltrevino")).toBe(false);
    });

    it("drops the retired domain and payment currency without null placeholders", () => {
        const domains = omitRemovedDomain({ zelf: { name: "zelf" }, bdag: { name: "bdag" }, avax: { name: "avax" } });
        expect(domains).toEqual({ zelf: { name: "zelf" }, avax: { name: "avax" } });

        const payment = stripRemovedPayment({
            currencies: ["ETH", "BDAG", "AVAX"],
            networks: { ethereum: { enabled: true }, blockdag: { enabled: true }, avalanche: { enabled: true } },
        });
        expect(payment.currencies).toEqual(["ETH", "AVAX"]);
        expect(payment.networks).toEqual({ ethereum: { enabled: true }, avalanche: { enabled: true } });
        expect(payment.networks.blockdag).toBeUndefined();
    });
});
