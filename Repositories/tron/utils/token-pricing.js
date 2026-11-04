const axios = require("axios");
const https = require("https");
const { getTRXPrice } = require("./trx-price");

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
		if (symbol === "USDT" || symbol === "USDC" || symbol === "USDJ" || symbol === "TUSD") {
			return "1.00";
		}

		// Handle TRX specifically
		if (symbol === "TRX" || symbol === "WTRX") {
			return await getTRXPrice();
		}

		// For other tokens, try CoinGecko first
		try {
			const symbolMap = {
				BTT: "bittorrent",
				WIN: "wink",
				SUN: "sun-token",
				JST: "just",
				NFT: "apenft",
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
			// Fallback to approximate prices for common Tron tokens
			const fallbackPrices = {
				BTT: "0.000001",
				WIN: "0.00001",
				SUN: "0.01",
				JST: "0.02",
				NFT: "0.0000005",
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
