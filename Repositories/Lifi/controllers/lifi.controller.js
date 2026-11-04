const Module = require("../modules/lifi.module.js");
const { errorHandler } = require("../../../Core/http-handler");
const { executeLimitedSwap } = require("../../ZelfKeys/modules/zelf-key-plan-limits.module");

/**
 * @param {Object} ctx
 */
const getChains = async (ctx) => {
	try {
		const data = await Module.getChains(ctx.request.query);

		ctx.body = { data };
	} catch (error) {
		ctx.status = error.status || 500;

		ctx.body = { error: error.message };
	}
};

/**
 * @param {Object} ctx
 */
const getQuote = async (ctx) => {
	try {
		const data = await Module.getQuote(ctx.request.query);

		ctx.body = { data };
	} catch (error) {
		ctx.status = error.status || 500;

		ctx.body = { error: error.message };
	}
};

/**
 * @param {Object} ctx
 */
const getStatus = async (ctx) => {
	try {
		const data = await Module.getStatus(ctx.request.query);

		ctx.body = { data };
	} catch (error) {
		ctx.status = error.status || 500;

		ctx.body = { error: error.message };
	}
};

/**
 * @param {Object} ctx
 */
const getTokenByChainId = async (ctx) => {
	try {
		const data = await Module.getTokenByChainId(ctx.request.query);

		ctx.body = { data };
	} catch (error) {
		ctx.status = error.status || 500;

		ctx.body = { error: error.message };
	}
};

/**
 * @param {Object} ctx
 */
const getTokens = async (ctx) => {
	try {
		const data = await Module.getTokens(ctx.request.query);

		ctx.body = { data };
	} catch (error) {
		ctx.status = error.status || 500;

		ctx.body = { error: error.message };
	}
};

/**
 * @param {Object} ctx
 */
const getTools = async (ctx) => {
	try {
		const data = await Module.getTools(ctx.request.query);

		ctx.body = { data };
	} catch (error) {
		ctx.status = error.status || 500;

		ctx.body = { error: error.message };
	}
};

/**
 * @param {Object} ctx
 */
const executeAdvancedStepTransaction = async (ctx) => {
	try {
		const outcome = await executeLimitedSwap({
			authUser: ctx.state.user,
			execute: () => Module.executeAdvancedStepTransaction(ctx.request.body),
		});

		ctx.body = { data: outcome.result, swaps: outcome.swaps };
	} catch (error) {
		if (error?.clientCode) {
			const handled = errorHandler(error, ctx);
			ctx.status = handled.status;
			ctx.body = {
				message: handled.message,
				code: handled.code,
				...(error.details && typeof error.details === "object" ? error.details : {}),
			};
			return;
		}

		ctx.status = error.status || 500;
		ctx.body = { error: error.message };
	}
};

module.exports = {
	getChains,
	getQuote,
	getStatus,
	getTokenByChainId,
	getTokens,
	getTools,
	executeAdvancedStepTransaction,
};
