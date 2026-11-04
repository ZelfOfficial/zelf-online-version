const axios = require("axios");
const https = require("https");
const { getETHPrice } = require("./eth-price");

const agent = new https.Agent({
	rejectUnauthorized: true,
});

/**
 * Get token price with special handling for stablecoins and symbol mapping
 * @param {string} symbol - Token symbol
 * @returns {string} Price as string
 */
const getTokenPrice = async (symbol) => {
	try {
		// Handle stablecoins - always $1
		if (symbol === "USDT" || symbol === "USDC" || symbol === "DAI" || symbol === "LUSD" || symbol === "USDT.e" || symbol === "USDC.e") {
			return "1.00";
		}

		// Handle ETH specifically
		if (symbol === "ETH" || symbol === "WETH") {
			return await getETHPrice();
		}

		// Handle synthetic USD and other $1 tokens
		if (symbol === "sUSD" || symbol === "FRAX") {
			return "1.00";
		}

		// For other tokens, try CoinGecko first
		try {
			const symbolMap = {
				OP: "optimism",
				SNX: "havven",
				LINK: "chainlink",
				UNI: "uniswap",
				AAVE: "aave",
				COMP: "compound-governance-token",
				MKR: "maker",
				CRV: "curve-dao-token",
				BAL: "balancer",
				"1INCH": "1inch",
				SUSHI: "sushi",
			};

			const coinId = symbolMap[symbol] || symbol.toLowerCase();
			const response = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`, {
				timeout: 5000,
				httpsAgent: agent,
			});

			if (response.data && response.data[coinId] && response.data[coinId].usd) {
				return response.data[coinId].usd.toString();
			}
		} catch (coinGeckoError) {
			// Fallback to approximate prices for common Optimism tokens
			const fallbackPrices = {
				OP: "2.5",
				SNX: "3.0",
				LINK: "15.0",
				UNI: "8.0",
				AAVE: "120.0",
			};

			return fallbackPrices[symbol] || "0.00";
		}

		return "0.00";
	} catch (error) {
		// If price fetch fails, return 0
		return "0.00";
	}
};

module.exports = {
	getTokenPrice,
};
