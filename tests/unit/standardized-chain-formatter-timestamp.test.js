const StandardizedChainFormatter = require("../../Repositories/class/standardized-chain-formatter");

describe("standardized-chain-formatter transaction timestamps", () => {
	const formatter = new StandardizedChainFormatter("OP Mainnet", "ETH", "https://example.com/eth.png");

	it("formats ISO date strings from provider rows instead of returning N/A", () => {
		const [tx] = formatter.formatTransactions([
			{
				hash: "0xabc",
				from: "0xsender",
				to: "0xreceiver",
				timestamp: Math.floor(Date.parse("2024-06-01T12:00:00.000000Z") / 1000),
				amount: "0.00001",
				price: 2500,
				traffic: "IN",
			},
		]);

		expect(tx.date).toBe("2024-06-01T12:00:00.000Z");
		expect(tx.timestamp).toBeGreaterThan(0);
		expect(tx.fiatAmount).toBe("0.03");
	});
});
