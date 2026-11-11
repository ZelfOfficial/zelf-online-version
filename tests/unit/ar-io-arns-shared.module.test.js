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

	it("maps zelf record keys to the configured index transaction id", () => {
		expect(resolveExpectedTransactionId("migueltrevino")).toBe(config.arns.index_transaction_id);
		expect(resolveExpectedTransactionId("@")).toBe(config.arns.index_transaction_id);
	});
});
