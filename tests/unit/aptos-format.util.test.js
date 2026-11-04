const {
    atomicToDecimalString,
    aptosFeeFromGas,
    decimalToAtomicString,
    expandScientificNotation,
} = require("../../Repositories/Aptos/modules/aptos-format.util");
const { mapCoinBalance } = require("../../Repositories/Aptos/modules/aptos-scrapping.module");

describe("Aptos amount formatting", () => {
    it("converts octas to exact APT strings", () => {
        expect(atomicToDecimalString("123456789")).toBe("1.23456789");
        expect(atomicToDecimalString("100000000")).toBe("1");
        expect(atomicToDecimalString("1")).toBe("0.00000001");
    });

    it("converts APT to octas without floating-point arithmetic", () => {
        expect(decimalToAtomicString("1.23456789")).toBe("123456789");
        expect(decimalToAtomicString("0.00000001")).toBe("1");
    });

    it("rejects zero, malformed values and excess precision", () => {
        expect(() => decimalToAtomicString("0")).toThrow(/greater_than_zero/);
        expect(() => decimalToAtomicString("1e-8")).toThrow(/amount_invalid/);
        expect(() => decimalToAtomicString("0.000000001")).toThrow(/exceeds_8_decimals/);
    });

    it("calculates gas fees in octas and APT", () => {
        expect(aptosFeeFromGas("151", "100")).toEqual({
            feeOctas: "15100",
            feeApt: "0.000151",
        });
    });

    it("expands scientific notation returned by numeric APIs", () => {
        expect(expandScientificNotation("1e+8")).toBe("100000000");
        expect(expandScientificNotation("1.5e+3")).toBe("1500");
    });

    it("maps both v1 AptosCoin and v2 fungible asset (0xa) to native APT with 8 decimals (#136)", () => {
        const faCoin = mapCoinBalance(
            {
                amount: 600000000,
                asset_type: "0x000000000000000000000000000000000000000000000000000000000000000a",
                metadata: null,
                token_standard: "v2",
            },
            "0.95"
        );
        expect(faCoin).toMatchObject({
            address_token: "APT",
            amount: "6",
            decimals: 8,
            fiatBalance: 5.7,
            symbol: "APT",
            tokenType: "APT",
        });
    });
});
