const assert = require("assert");
const axiosCore = require("../Core/axios");
const binanceModule = require("../Repositories/binance/modules/binance.module");

const mockGetResponses = new Map();
const mockAxiosInstance = {
	get: async (url) => {
		for (const [pattern, handler] of mockGetResponses.entries()) {
			if (url.includes(pattern)) {
				return { data: typeof handler === "function" ? await handler(url) : handler };
			}
		}
		throw new Error(`Unexpected GET ${url}`);
	},
};

axiosCore.getCleanInstance = () => mockAxiosInstance;
binanceModule.getTickerPrice = async ({ symbol }) => {
	if (symbol === "XLM") return { price: "0.25" };
	if (symbol === "EUR") return { price: "1.08" };
	if (symbol === "AQUA") return { price: "0.005" };
	throw new Error(`409:Unknown symbol ${symbol}`);
};

const stellarModule = require("../Repositories/Stellar/modules/stellar-scrapping.module");

async function runTests() {
	const userAddress = "GUSER111111111111111111111111111111111111111111111111111";
	const funderAddress = "GFUNDER2222222222222222222222222222222222222222222222222";
	const recipientAddress = "GRECIPIENT3333333333333333333333333333333333333333333333";

	// 1. formatStroopsToXlm avoids IEEE-754 floating-point drift (#216)
	assert.strictEqual(stellarModule.formatStroopsToXlm(100), "0.00001");
	assert.strictEqual(stellarModule.formatStroopsToXlm("100"), "0.00001");
	assert.strictEqual(stellarModule.formatStroopsToXlm(10000000), "1");
	assert.strictEqual(stellarModule.formatStroopsToXlm(10100000), "1.01");
	assert.strictEqual(stellarModule.formatStroopsToXlm(0), "0");

	// 2. extractPaymentInfo handles create_account (#216)
	const createAccountInfo = stellarModule.extractPaymentInfo(
		{
			type: "create_account",
			funder: funderAddress,
			account: userAddress,
			starting_balance: "1.0100000",
		},
		userAddress
	);
	assert.strictEqual(createAccountInfo.from, funderAddress);
	assert.strictEqual(createAccountInfo.to, userAddress);
	assert.strictEqual(createAccountInfo.amount, 1.01);
	assert.strictEqual(createAccountInfo.asset, "XLM");
	assert.strictEqual(createAccountInfo.operationType, "create_account");

	// 3. extractPaymentInfo handles path_payment_strict_send & account_merge (#216)
	const pathPaymentInfo = stellarModule.extractPaymentInfo(
		{
			type: "path_payment_strict_send",
			from: userAddress,
			to: recipientAddress,
			source_amount: "10.5000000",
			source_asset_type: "native",
			amount: "2.6250000",
			asset_type: "credit_alphanum4",
			asset_code: "USDC",
		},
		userAddress
	);
	assert.strictEqual(pathPaymentInfo.from, userAddress);
	assert.strictEqual(pathPaymentInfo.to, recipientAddress);
	assert.strictEqual(pathPaymentInfo.amount, 10.5);
	assert.strictEqual(pathPaymentInfo.asset, "XLM");

	const mergeInfo = stellarModule.extractPaymentInfo(
		{
			type: "account_merge",
			account: funderAddress,
			into: userAddress,
			amount: "4.5000000",
		},
		userAddress
	);
	assert.strictEqual(mergeInfo.from, funderAddress);
	assert.strictEqual(mergeInfo.to, userAddress);
	assert.strictEqual(mergeInfo.amount, 4.5);
	assert.strictEqual(mergeInfo.asset, "XLM");

	// 4. getAddress calculates token fiat balances and USD tokenHoldings.balance (#215)
	// and formats transactions with create_account & multi-op selection (#216)
	mockGetResponses.set(`/accounts/${userAddress}/transactions`, {
		_embedded: {
			records: [
				{
					id: "tx_create",
					hash: "tx_create",
					created_at: "2026-11-01T12:00:00Z",
					source_account: funderAddress,
					fee_charged: "100",
					successful: true,
					_links: {},
				},
				{
					id: "tx_multi_op",
					hash: "tx_multi_op",
					created_at: "2026-11-01T13:30:00Z",
					source_account: funderAddress,
					fee_charged: "200",
					successful: true,
					_links: {},
				},
			],
		},
	});

	mockGetResponses.set("/transactions/tx_create/operations", {
		_embedded: {
			records: [
				{
					type: "create_account",
					funder: funderAddress,
					account: userAddress,
					starting_balance: "1.0100000",
				},
			],
		},
	});

	mockGetResponses.set("/transactions/tx_multi_op/operations", {
		_embedded: {
			records: [
				{
					type: "change_trust",
					source_account: funderAddress,
				},
				{
					type: "payment",
					from: funderAddress,
					to: userAddress,
					amount: "5.9600000",
					asset_type: "credit_alphanum4",
					asset_code: "USDC",
				},
			],
		},
	});

	mockGetResponses.set(`/accounts/${userAddress}`, {
		id: userAddress,
		type: "account",
		balances: [
			{
				balance: "5.9600000",
				asset_type: "credit_alphanum4",
				asset_code: "USDC",
				asset_issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
			},
			{
				balance: "2500000000.0000000",
				asset_type: "credit_alphanum4",
				asset_code: "SHIBX",
				asset_issuer: "GSHIBISSUER11111111111111111111111111111111111111111111",
			},
			{
				balance: "10.0000000",
				asset_type: "native",
			},
		],
	});

	const accountData = await stellarModule.getAddress({ id: userAddress }, { limit: 10 });

	// XLM native: 10 XLM * $0.25 = $2.50
	assert.strictEqual(accountData.balance, 10);
	assert.strictEqual(accountData.account.price, "0.25");
	assert.strictEqual(accountData.account.fiatValue, "2.50000");

	// USDC token: 5.96 USDC * $1.00 = $5.96
	const usdcToken = accountData.tokenHoldings.tokens.find((t) => t.asset === "USDC");
	assert.ok(usdcToken, "Expected USDC token in tokenHoldings.tokens");
	assert.strictEqual(usdcToken.symbol, "USDC");
	assert.strictEqual(usdcToken.price, 1);
	assert.strictEqual(usdcToken.fiatBalance, 5.96);

	// Unpriced token SHIBX should have fiatBalance 0 and NOT inflate tokenHoldings.balance to 2.5B
	const shibxToken = accountData.tokenHoldings.tokens.find((t) => t.asset === "SHIBX");
	assert.ok(shibxToken, "Expected SHIBX token in tokenHoldings.tokens");
	assert.strictEqual(shibxToken.fiatBalance, 0);

	assert.strictEqual(accountData.tokenHoldings.fiatBalance, 5.96);
	assert.strictEqual(accountData.tokenHoldings.balance, 5.96);
	assert.strictEqual(Number(accountData.fiatBalance.toFixed(2)), 8.46);

	// Transactions assertions (#216)
	assert.strictEqual(accountData.transactions.length, 2);
	const [txCreate, txMultiOp] = accountData.transactions;

	assert.strictEqual(txCreate.hash, "tx_create");
	assert.strictEqual(txCreate.from, funderAddress);
	assert.strictEqual(txCreate.to, userAddress);
	assert.strictEqual(txCreate.amount, 1.01);
	assert.strictEqual(txCreate.asset, "XLM");
	assert.strictEqual(txCreate.fee, "0.00001");
	assert.strictEqual(txCreate.traffic, "IN");
	assert.strictEqual(txCreate.timestamp, "2026-11-01T12:00:00.000Z");
	assert.strictEqual(txCreate.time, "12:00:00 UTC");

	assert.strictEqual(txMultiOp.hash, "tx_multi_op");
	assert.strictEqual(txMultiOp.from, funderAddress);
	assert.strictEqual(txMultiOp.to, userAddress);
	assert.strictEqual(txMultiOp.amount, 5.96);
	assert.strictEqual(txMultiOp.asset, "USDC");
	assert.strictEqual(txMultiOp.fee, "0.00002");
	assert.strictEqual(txMultiOp.traffic, "IN");

	console.log("All Stellar #215 and #216 unit tests passed!");
}

runTests().catch((err) => {
	console.error(err);
	process.exit(1);
});
