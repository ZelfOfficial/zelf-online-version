const { mapBlockscoutErc20Item } = require("../../Repositories/etherscan/modules/blockscout-token-list.util");

describe("blockscout token list mapping", () => {
	it("keeps the holding fields used by the extension", () => {
		const row = mapBlockscoutErc20Item({
			value: "2500000",
			token: {
				address: "0xusdc",
				name: "USD Coin",
				symbol: "USDC",
				decimals: "6",
				exchange_rate: "1",
				icon_url: "https://example.com/usdc.png",
				type: "ERC-20",
			},
		});

		expect(row).toEqual({
			address: "0xusdc",
			symbol: "USDC",
			name: "USD Coin",
			decimals: 6,
			amount: "2.5",
			price: "1",
			fiatBalance: 2.5,
			image: "https://example.com/usdc.png",
			tokenType: "ERC-20",
			contractAddress: "0xusdc",
		});
	});

	it("drops rows that cannot be formatted", () => {
		expect(mapBlockscoutErc20Item({ value: "1.5", token: { address: "0x1", decimals: "6" } })).toBeNull();
		expect(mapBlockscoutErc20Item({ value: "1" })).toBeNull();
	});
});
