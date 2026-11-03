const config = require("../../../Core/config");
const { getCleanInstance } = require("../../../Core/axios");

const instance = getCleanInstance(30000);

const lifiRequest = () => ({
	url: config.lifi.url,
	integrator: config.lifi.integrator,
	headers: { headers: { "x-api-key": config.lifi.apiKey } },
});

const EXECUTE_SOLANA_SWAP_REQUIRED_PARAMS = {
	fromChain: true,
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
	},
};

const getChains = async (params) => {
	const lifi = lifiRequest();
	const { data } = await instance.get(`${lifi.url}/chains`, { params, headers: lifi.headers });

	return data;
};

const getQuote = async (params) => {
	const lifi = lifiRequest();
	const { data } = await instance.get(`${lifi.url}/quote`, { params: { ...params, integrator: lifi.integrator }, headers: lifi.headers });

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
	const requiredParams = Object.keys(EXECUTE_SOLANA_SWAP_REQUIRED_PARAMS);

	let missingParams = requiredParams.filter((param) => !params[param]);
	let missingActionParams = Object.keys(params?.action || {}).filter((param) => !params?.action?.[param]);

	if (missingParams.length > 0 || missingActionParams.length > 0) {
		throw new Error(
			`Missing required parameters: ${missingParams.join(", ")} ${
				missingActionParams.length > 0 ? `action.${missingActionParams.join(", action.")}` : ""
			}`
		);
	}

	const lifi = lifiRequest();
	const { data } = await instance.post(`${lifi.url}/advanced/stepTransaction`, { ...params, integrator: lifi.integrator }, lifi.headers);

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
