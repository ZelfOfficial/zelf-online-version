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

	// 2. When Blockscout and BaseScan fail, history is an empty list and OKLink is not called.
	const origAxiosGet = axios.get;
	const origAxiosPost = axios.post;
	const origAxiosCreate = axios.create;
	const origGetTickerPrice = binanceModule.getTickerPrice;
	try {
		binanceModule.getTickerPrice = async () => ({ price: "2500" });
		axios.create = () => ({
			get: async () => {
				const err = new Error("blockscout and basescan disabled in this test");
				err.response = { status: 404 };
				throw err;
			},
			post: async () => {
				throw new Error("rpc disabled");
			},
		});
		axios.post = async () => {
			throw new Error("alchemy disabled");
		};
		axios.get = async (url) => {
			if (String(url).includes("oklink.com")) {
				throw new Error("oklink should not be called");
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

		assert.deepStrictEqual(res.transactions, []);
		assert.ok(!String(res.source || "").includes("oklink"));

		const emptyRes = await baseModule.getTransactionsList({
			address: "0x75F766ae57E08C9470CCe2AC30dD2b6B009Fccde",
			page: "0",
			show: "20",
		});
		assert.deepStrictEqual(emptyRes.transactions, []);
		assert.ok(!JSON.stringify(emptyRes).includes("0x0000000000000000000000000000000000000000000000000000000000000000"));
	} finally {
		axios.get = origAxiosGet;
		axios.post = origAxiosPost;
		axios.create = origAxiosCreate;
		binanceModule.getTickerPrice = origGetTickerPrice;
	}

	console.log("All Base transaction history tests (#153) passed!");
}

if (typeof test === "function") {
	test("Base history keeps standardized fields and omits placeholder rows", () => runTests());
} else {
	runTests().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
