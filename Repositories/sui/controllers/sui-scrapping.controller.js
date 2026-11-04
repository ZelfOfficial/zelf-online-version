const Module = require("../modules/sui-scrapping.module");

const safeLog = (value) => String(value || "sui_upstream_unavailable").replace(/https?:\/\/\S+/gi, "[url]").slice(0, 200);

const fail = (ctx, error, label) => {
	const code = error.code || error.message || "sui_upstream_unavailable";
	console.error(`[sui] ${label}: ${safeLog(code)}`);
	ctx.status = error.status || 500;
	ctx.body = { error: error.message || code, code };
};

const address = async (ctx) => {
	try {
		const data = await Module.getAddress(ctx.request.params);

		ctx.body = { data };
	} catch (error) {
		fail(ctx, error, "address");
	}
};

const transactions = async (ctx) => {
	try {
		const data = await Module.getTransactions(ctx.request.params, ctx.request.query);

		ctx.body = { data };
	} catch (error) {
		fail(ctx, error, "transactions");
	}
};

const transaction = async (ctx) => {
	try {
		const data = await Module.getTransaction(ctx.request.params);

		ctx.body = { data };
	} catch (error) {
		fail(ctx, error, "transaction");
	}
};

const tokens = async (ctx) => {
	try {
		const data = await Module.getTokens(ctx.request.params, ctx.request.query);

		ctx.body = { data };
	} catch (error) {
		fail(ctx, error, "tokens");
	}
};
module.exports = {
	address,
	transactions,
	transaction,
	tokens,
};
