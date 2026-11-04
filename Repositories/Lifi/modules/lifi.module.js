const config = require("../../../Core/config");
const { getCleanInstance } = require("../../../Core/axios");

const instance = getCleanInstance(30000);

/**
 * LI.FI authenticates with `x-lifi-api-key`. Omit the header when no key is configured:
 * a wrong key is rejected, and quotes still succeed without one.
 * @returns {{ url: string, integrator: string|undefined, headers: Object }}
 */
const lifiRequest = () => {
	const apiKey = typeof config.lifi.apiKey === "string" ? config.lifi.apiKey.trim() : "";
	const headers = {};

	if (apiKey) headers["x-lifi-api-key"] = apiKey;

	return {
		url: config.lifi.url,
		integrator: config.lifi.integrator,
		headers,
	};
};

const isBlank = (value) => value === undefined || value === null || value === "";

/**
 * Fields a LI.FI step must have before `/advanced/stepTransaction`.
 * `fromChain` is not part of the quote step. A falsy extra such as Solana
 * `svmMaxSupportedTransactionVersion: 0` is not a missing field.
 */
const EXECUTE_STEP_REQUIRED_PARAMS = {
	id: true,
	tool: true,
	type: true,
	action: {
		fromAddress: true,
		fromAmount: true,
		fromChainId: true,
		fromToken: true,
		slippage: true,
		toAddress: true,
		toChainId: true,
		toToken: true,
	},
};

const getChains = async (params) => {
	const lifi = lifiRequest();
	const { data } = await instance.get(`${lifi.url}/chains`, { params, headers: lifi.headers });

	return data;
};

const getQuote = async (params) => {
	const lifi = lifiRequest();
	const quoteParams = { ...params };
	delete quoteParams.referrer;
	if (lifi.integrator) quoteParams.integrator = lifi.integrator;

	const { data } = await instance.get(`${lifi.url}/quote`, { params: quoteParams, headers: lifi.headers });

	return data;
};

const getStatus = async (params) => {
	const lifi = lifiRequest();
	const { data } = await instance.get(`${lifi.url}/status`, { params, headers: lifi.headers });

	return data;
};

const getTokenByChainId = async (params) => {
	const lifi = lifiRequest();
	const { data } = await instance.get(`${lifi.url}/token`, { params, headers: lifi.headers });

	return data;
};

const getTokens = async (params) => {
	const lifi = lifiRequest();
	const { data } = await instance.get(`${lifi.url}/tokens`, { params, headers: lifi.headers });

	return data;
};

const getTools = async (params) => {
	const lifi = lifiRequest();
	const { data } = await instance.get(`${lifi.url}/tools`, { params, headers: lifi.headers });

	return data;
};

const executeAdvancedStepTransaction = async (params) => {
	const requiredParams = Object.keys(EXECUTE_STEP_REQUIRED_PARAMS).filter((key) => key !== "action");
	const missingParams = requiredParams.filter((param) => isBlank(params?.[param]));

	if (isBlank(params?.action) || typeof params.action !== "object") missingParams.push("action");

	const missingActionParams =
		params?.action && typeof params.action === "object"
			? Object.keys(EXECUTE_STEP_REQUIRED_PARAMS.action).filter((param) => isBlank(params.action[param]))
			: [];

	if (missingParams.length > 0 || missingActionParams.length > 0) {
		const actionMessage = missingActionParams.length > 0 ? `action.${missingActionParams.join(", action.")}` : "";
		throw new Error(`Missing required parameters: ${[missingParams.join(", "), actionMessage].filter(Boolean).join(" ")}`);
	}

	const lifi = lifiRequest();
	const body = { ...params };
	delete body.referrer;
	if (lifi.integrator) body.integrator = lifi.integrator;

	const { data } = await instance.post(`${lifi.url}/advanced/stepTransaction`, body, { headers: lifi.headers });

	return data;
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
