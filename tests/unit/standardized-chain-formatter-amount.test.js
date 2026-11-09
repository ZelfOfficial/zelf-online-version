const StandardizedChainFormatter = require("../../Repositories/class/standardized-chain-formatter");

describe("standardized-chain-formatter amount strings", () => {
	const formatter = new StandardizedChainFormatter("OP Mainnet", "ETH", "https://example.com/eth.png");

	it("strips trailing zeros only when the amount contains a decimal point", () => {
		expect(formatter.formatAmountString("10")).toBe("10");
		expect(formatter.formatAmountString("250")).toBe("250");
		expect(formatter.formatAmountString("6000000")).toBe("6000000");
		expect(formatter.formatAmountString("6000000.0")).toBe("6000000");
		expect(formatter.formatAmountString("1.2300")).toBe("1.23");
		expect(formatter.formatAmountString("0.000")).toBe("0");
		expect(formatter.formatAmountString("0")).toBe("0");
	});

	it("leaves a whole number unchanged, including a leading plus", () => {
		expect(formatter.formatAmountString("+10")).toBe("+10");
		expect(formatter.formatAmountString("+6000000")).toBe("+6000000");
		expect(formatter.formatAmountString("+1.2300")).toBe("+1.23");
	});

	it("does not trim exponent digits when toFixed has no decimal point", () => {
		expect(formatter.formatAmountString("1e+30")).toBe("1e+30");
	});

	it("keeps whole-number history amounts and fees", () => {
		const [tx] = formatter.formatTransactions([
			{
				hash: "0x" + "ab".repeat(32),
				from: "0x" + "11".repeat(20),
				to: "0x" + "22".repeat(20),
				amount: "250",
				txnFee: "10",
				traffic: "IN",
			},
		]);

		expect(tx.amount).toBe("250");
		expect(tx.txnFee).toBe("10");
	});
});
