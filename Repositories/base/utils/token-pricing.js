const { getTickerPrice } = require("../../binance/modules/binance.module");

/**
 * Get token price with special handling for stablecoins and symbol mapping
 * @param {string} symbol - Token symbol
 * @returns {string} Price as string
 */
const getTokenPrice = async (symbol) => {
	try {
		// Handle stablecoins - always $1
		if (symbol === "USDT" || symbol === "USDC" || symbol === "DAI") {
			return "1.00";
		}

		// Map symbols to Binance-compatible format
		let binanceSymbol = symbol;

		if (symbol === "cbETH" || symbol === "WETH") {
			binanceSymbol = "ETH"; // Use ETH price for cbETH / WETH
		} else if (symbol === "cbBTC") {
			binanceSymbol = "BTC"; // Coinbase Wrapped BTC tracks BTC
		} else if (symbol === "rETH" || symbol === "stETH") {
			binanceSymbol = "ETH"; // Use ETH price for staking derivatives
		} else if (symbol === "TORN") {
			binanceSymbol = "ETH"; // Use ETH price as fallback for TORN
		}

		// Get price from Binance API
		const priceData = await getTickerPrice({ symbol: binanceSymbol });
		return priceData.price || "0.00";
	} catch (error) {
		// If price fetch fails, return 0
		return "0.00";
	}
};

module.exports = {
	getTokenPrice,
};
