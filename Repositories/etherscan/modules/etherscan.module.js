const config = require("../../../Core/config");
const { getCleanInstance } = require("../../../Core/axios");
const instance = getCleanInstance(30000);
const ETHERSCAN_V2 = process.env.ETHERSCAN_V2_API || "https://api.etherscan.io/v2/api";
const etherscanApiKey = () => String(process.env.ETHERSCAN_API_KEY || "").trim();

/**
 * @param {*} params
 */

const getBalance = async (params) => {
	const apiKey = etherscanApiKey();
	const { data } = await instance.get(
		`${config.etherscan.urlEtherscan}?module=account&action=balance&address=${params.address}&tag=latest&apikey=${apiKey}`
	);

	return { balance: data.result };
};

const getBlocke = async () => {
	const apiKey = etherscanApiKey();
	const { data } = await instance.get(`${config.etherscan.urlEtherscan}?module=proxy&action=eth_blockNumber&apikey=${apiKey}`);

	const decimalNumber = parseInt(data.result, 16);
	return { blockNumber: decimalNumber };
};

/**
 * @param {*} params
 */

const getTransactions = async (params) => {
	const apiKey = etherscanApiKey();
	const { data } = await instance.get(
		`${config.etherscan.urlEtherscan}?module=account&address=${params.address}&offset=40&sort=desc&action=tokentx&tag=latest&page=1&apikey=${apiKey}`
	);

	return { transactions: data.result };
};

const getTokentx = async (params) => {
	const apiKey = etherscanApiKey();
	let { data } = await instance.get(
		`${config.etherscan.urlEtherscan}?module=account&action=tokentx&address=${params.address}&startblock=0&endblock=99999999&sort=asc&apikey=${apiKey}`
	);

	return { tokentx: data.result };
};

const getGasTracker = async () => {
	const apiKey = etherscanApiKey();
	const { data } = await instance.get(ETHERSCAN_V2, {
		params: {
			chainid: 1,
			module: "gastracker",
			action: "gasoracle",
			apikey: apiKey,
		},
	});

	return data.result;
};

module.exports = {
	getTransactions,
	getGasTracker,
	getBalance,
	getTokentx,
	getBlocke,
};
