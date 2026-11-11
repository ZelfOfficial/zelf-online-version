const config = require("../../Core/config");
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

	it("does not treat a removed suffix as its own registry", () => {
		expect(resolveDomainForRecordKey("john4_bdag")).toBe("zelf");
		expect(parseRecordKey("john4_bdag")).toEqual({ tagName: "john4_bdag", domain: "zelf" });
	});

	it("resolves socials domain without treating it as the main zelf page", () => {
		expect(resolveDomainForRecordKey("liza_socials")).toBe("socials");
		expect(parseRecordKey("liza_socials")).toEqual({ tagName: "liza", domain: "socials" });
	});

	it("maps record keys to expected transaction ids from config", () => {
		expect(resolveExpectedTransactionId("migueltrevino")).toBe(config.arns.index_transaction_id);
		expect(resolveExpectedTransactionId("liza_socials")).toBe(config.arns.socials_transaction_id);
		expect(resolveExpectedTransactionId("@")).toBe(config.arns.index_transaction_id);
	});
});
