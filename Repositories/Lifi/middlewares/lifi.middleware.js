const config = require("../../../Core/config");
const Joi = require("joi");

const { string, object, array, validate, stringEnum, forbidden, stringOrNumber, minMaxNumber, number } = require("../../../Core/JoiUtils");

/** Top-level and included LI.FI step types. `stringEnum` takes one array. */
const LIFI_STEP_TYPES = ["swap", "lifi", "cross", "protocol", "custom"];

/**
 * Token object on a LI.FI step (`action.fromToken` / `action.toToken`).
 * A quote from li.quest and from GET /api/lifi/quote sends this object, not an address string.
 */
const lifiToken = () =>
	object({
		address: string().required(),
		chainId: stringOrNumber().required(),
		decimals: number().required(),
		symbol: string().required(),
	}).unknown(true);

const schemas = {
	executeAdvancedStepTransaction: {
		// Present on older app payloads. A li.quest quote step does not include it.
		fromChain: stringOrNumber(),
		id: string().required(),
		// Echoed on the quote. Execute overwrites it with config.lifi.integrator.
		integrator: string(),
		referrer: forbidden(),
		tool: string().required(),
		type: stringEnum(LIFI_STEP_TYPES).required(),
		action: object({
			fromAddress: string().required(),
			fromAmount: stringOrNumber().required(),
			fromChainId: stringOrNumber().required(),
			fromToken: lifiToken().required(),
			slippage: minMaxNumber(0, 1).required(),
			toAddress: string().required(),
			toChainId: stringOrNumber().required(),
			toToken: lifiToken().required(),
		})
			.unknown(true)
			.required(),
		toolDetails: object({
			key: string(),
			name: string(),
			logoURI: string(),
		}).unknown(true),
		estimate: object({
			approvalAddress: string().required(),
			executionDuration: stringOrNumber().required(),
			feeCosts: array().required(),
			fromAmount: stringOrNumber().required(),
			fromAmountUSD: stringOrNumber(),
			gasCosts: array().required(),
			toAmount: stringOrNumber().required(),
			toAmountMin: stringOrNumber().required(),
			toAmountUSD: stringOrNumber(),
			tool: string().required(),
		})
			.unknown(true)
			.required(),
	},
	getChains: {
		chainTypes: string(),
	},
	getByChainId: {
		chain: stringOrNumber().required(),
		token: string().required(),
	},
	getQuote: {
		fromAddress: string().required(),
		fromAmount: string().required(),
		fromChain: string().required(),
		fromToken: string().required(),
		integrator: forbidden(),
		referrer: forbidden(),
		slippage: minMaxNumber(0, 1).required(),
		toAddress: Joi.string().trim().allow("").optional(),
		toChain: string().required(),
		toToken: string().required(),
	},
	getStatus: {
		bridge: string(),
		fromChain: string(),
		toChain: string(),
		txHash: string().required(),
	},
	getTokens: {
		chains: string(),
		chainTypes: string(),
		minPriceUSD: number(),
	},
	getTools: {
		chain: stringOrNumber(),
	},
};

const executeAdvancedStepTransactionValidation = async (ctx, next) => {
	if (!_configValidation(ctx)) return;

	// Keep the quote step unchanged: no coercion and no dropped fields. The body is posted to LI.FI as-is.
	const valid = Joi.object(schemas.executeAdvancedStepTransaction).unknown(true).validate(ctx.request.body, {
		abortEarly: false,
		convert: false,
		stripUnknown: false,
	});

	if (valid.error) {
		ctx.status = 400;
		ctx.body = { validationError: valid.error.message };
		return;
	}

	ctx.request.body = valid.value;

	return next();
};

const getChainsValidation = async (ctx, next) => {
	if (!_configValidation(ctx) || !_validate(ctx, "query", schemas.getChains)) return;

	return next();
};

const getQuoteValidation = async (ctx, next) => {
	if (!_configValidation(ctx) || !_validate(ctx, "query", schemas.getQuote)) return;

	return next();
};

const getStatusValidation = async (ctx, next) => {
	if (!_configValidation(ctx) || !_validate(ctx, "query", schemas.getStatus)) return;

	return next();
};

const getTokenByChainIdValidation = async (ctx, next) => {
	if (!_configValidation(ctx)) return;

	if (!_validate(ctx, "query", schemas.getByChainId)) return;

	return next();
};

const getTokensValidation = async (ctx, next) => {
	if (!_configValidation(ctx) || !_validate(ctx, "query", schemas.getTokens)) return;

	return next();
};

const getToolsValidation = async (ctx, next) => {
	if (!_configValidation(ctx)) return;

	return next();
};

const _configValidation = (ctx) => {
	if (!config.lifi.apiKey || !config.lifi.url || !config.lifi.integrator) {
		ctx.status = 501;
		ctx.body = { error: "service_unavailable" };

		return;
	}

	return true;
};

const _validate = (ctx, source, schema) => {
	const valid = validate(schema, ctx[source]);

	if (valid.error) {
		ctx.status = 400;
		ctx.body = { validationError: valid.error.message };

		return;
	}

	ctx[source] = valid.value;

	return true;
};

module.exports = {
	executeAdvancedStepTransactionValidation,
	getChainsValidation,
	getQuoteValidation,
	getStatusValidation,
	getTokenByChainIdValidation,
	getTokensValidation,
	getToolsValidation,
};
