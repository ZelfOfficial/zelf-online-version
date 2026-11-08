const assert = require("assert");
const axios = require("axios");
const StandardizedChainFormatter = require("../Repositories/class/standardized-chain-formatter");
const binanceModule = require("../Repositories/binance/modules/binance.module");

async function runTests() {
	const formatter = new StandardizedChainFormatter("Base", "ETH", "https://s2.coinmarketcap.com/static/img/coins/64x64/1027.png");

	// 1. StandardizedChainFormatter preserves fiatValue/fiatAmount when price is not provided on tx
	const formattedWithFiatValue = formatter.formatTransaction({
		hash: "0x" + "a".repeat(64),
		from: "0x75F766ae57E08C9470CCe2AC30dD2b6B009Fccde",
		to: "0xB8aB5d8c00000000000000000000000000002117",
		value: "0.5",
		fiatValue: "1500.00",
		blocktime: 1759259709,
		traffic: "OUT",
	});
	assert.strictEqual(formattedWithFiatValue.fiatAmount, "1500.00");
	assert.strictEqual(formattedWithFiatValue.amount, "0.5");
	assert.strictEqual(formattedWithFiatValue.asset, "ETH");
	assert.ok(formattedWithFiatValue.date && formattedWithFiatValue.date !== "N/A");

	// 2. Test Base getTransactionsList formats OKLink transactions with date, amount, fiatAmount, and asset
	const origAxiosGet = axios.get;
	const origGetTickerPrice = binanceModule.getTickerPrice;
	try {
		binanceModule.getTickerPrice = async () => ({ price: "2500" });
		axios.get = async (url) => {
			if (url.includes("oklink.com/api/explorer/v2/base/addresses/")) {
				return {
					data: {
						code: "0",
						data: {
							total: 1,
							hits: [
								{
									hash: "0x" + "b".repeat(64),
									blockHeight: 123456,
									from: "0x75F766ae57E08C9470CCe2AC30dD2b6B009Fccde",
									to: "0x6B4dd62800000000000000000000000000002d5C",
									value: "0.1",
									blocktime: 1759259709,
									method: "ETH transfer",
									status: "0x1",
									fee: "0.00001",
								},
							],
						},
					},
				};
			}
			throw new Error("Unexpected URL: " + url);
		};

		delete require.cache[require.resolve("../Repositories/base/modules/base-scrapping.module")];
		const baseModule = require("../Repositories/base/modules/base-scrapping.module");
		const res = await baseModule.getTransactionsList({
			address: "0x75F766ae57E08C9470CCe2AC30dD2b6B009Fccde",
			page: "0",
			show: "20",
		});

		assert.strictEqual(res.source, "oklink");
		assert.strictEqual(res.transactions.length, 1);
		const tx = res.transactions[0];
		assert.strictEqual(tx.hash, "0x" + "b".repeat(64));
		assert.strictEqual(tx.asset, "ETH");
		assert.strictEqual(tx.traffic, "OUT");
		assert.strictEqual(tx.fiatAmount, "250.00");
		assert.strictEqual(Number(tx.amount), 0.1);
		assert.ok(tx.date && tx.date !== "N/A", "Transaction must have a valid date string");

		// 3. Test empty result does not emit a fake 0x0000... placeholder transaction
		axios.get = async () => ({ data: { code: "0", data: { total: 0, hits: [] } } });
		const emptyRes = await baseModule.getTransactionsList({
			address: "0x75F766ae57E08C9470CCe2AC30dD2b6B009Fccde",
			page: "0",
			show: "20",
		});
		assert.deepStrictEqual(emptyRes.transactions, []);
	} finally {
		axios.get = origAxiosGet;
		binanceModule.getTickerPrice = origGetTickerPrice;
	}

	console.log("All Base transaction history tests (#153) passed!");
}

runTests().catch((err) => {
	console.error(err);
	process.exit(1);
});
