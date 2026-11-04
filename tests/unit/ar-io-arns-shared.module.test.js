const {
	resolveDomainForRecordKey,
	resolveExpectedTransactionId,
	parseRecordKey,
} = require("../../Repositories/Arweave/modules/ar-io-arns-shared.module");

describe("ar-io-arns-shared.module", () => {
	it("resolves zelf domain for bare record keys", () => {
		expect(resolveDomainForRecordKey("migueltrevino")).toBe("zelf");
		expect(parseRecordKey("migueltrevino")).toEqual({ tagName: "migueltrevino", domain: "zelf" });
	});

	it("resolves bdag domain for suffixed record keys", () => {
		expect(resolveDomainForRecordKey("john4_bdag")).toBe("bdag");
		expect(parseRecordKey("john4_bdag")).toEqual({ tagName: "john4", domain: "bdag" });
	});

	it("resolves socials domain without treating it as the main zelf page", () => {
		expect(resolveDomainForRecordKey("liza_socials")).toBe("socials");
		expect(parseRecordKey("liza_socials")).toEqual({ tagName: "liza", domain: "socials" });
	});

	it("maps record keys to expected transaction ids from config", () => {
		expect(typeof resolveExpectedTransactionId("migueltrevino")).toBe("string");
		expect(typeof resolveExpectedTransactionId("john4_bdag")).toBe("string");
		expect(typeof resolveExpectedTransactionId("@")).toBe("string");
	});
});
