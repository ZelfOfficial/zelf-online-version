const axios = require("axios");
const https = require("https");

const agent = new https.Agent({
	rejectUnauthorized: true,
});

/**
 * Get TRX price in USD from multiple sources with USA-optimized priority
 * Note: Binance US has incorrect TRX prices, so we prioritize reliable sources
 * @returns {Promise<string>} TRX price in USD as string
 */
const getTRXPrice = async () => {
	try {
		// 1. Try CoinGecko first (most reliable for TRX, USA-accessible)
		try {
			const response = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=tron&vs_currencies=usd", {
				timeout: 5000,
				httpsAgent: agent,
			});

			if (response.data && response.data.tron && response.data.tron.usd) {
				console.log(`✅ Got TRX price from CoinGecko: $${response.data.tron.usd}`);
				return response.data.tron.usd.toString();
			}
		} catch (coinGeckoError) {
			console.log("CoinGecko TRX price failed:", coinGeckoError.message);
		}

		// 2. Try Binance Global (reliable TRX price, accessible from USA)
		try {
			const response = await axios.get("https://api.binance.com/api/v3/ticker/price?symbol=TRXUSDT", {
				timeout: 5000,
				httpsAgent: agent,
			});

			if (response.data && response.data.price) {
				console.log(`✅ Got TRX price from Binance Global: $${response.data.price}`);
				return response.data.price;
			}
		} catch (binanceGlobalError) {
			console.log("Binance Global TRX price failed:", binanceGlobalError.message);
		}

		// 3. Try Coinbase Pro (USA-based exchange)
		try {
			const response = await axios.get("https://api.exchange.coinbase.com/products/TRX-USD/ticker", {
				timeout: 5000,
				httpsAgent: agent,
			});

			if (response.data && response.data.price) {
				console.log(`✅ Got TRX price from Coinbase Pro: $${response.data.price}`);
				return response.data.price;
			}
		} catch (coinbaseError) {
			console.log("Coinbase Pro TRX price failed:", coinbaseError.message);
		}

		// 4. Try CoinMarketCap API
		try {
			const response = await axios.get("https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=TRX", {
				timeout: 5000,
				httpsAgent: agent,
				headers: {
					"X-CMC_PRO_API_KEY": process.env.CMC_API_KEY || "demo-key",
					Accept: "application/json",
				},
			});

			if (response.data && response.data.data && response.data.data.TRX) {
				const price = response.data.data.TRX.quote.USD.price;
				console.log(`✅ Got TRX price from CoinMarketCap: $${price}`);
				return price.toString();
			}
		} catch (cmcError) {
			console.log("CoinMarketCap TRX price failed:", cmcError.message);
		}

		// 5. Try CryptoCompare as last resort
		try {
			const response = await axios.get("https://min-api.cryptocompare.com/data/price?fsym=TRX&tsyms=USD", {
				timeout: 5000,
				httpsAgent: agent,
			});

			if (response.data && response.data.USD) {
				console.log(`✅ Got TRX price from CryptoCompare: $${response.data.USD}`);
				return response.data.USD.toString();
			}
		} catch (cryptoCompareError) {
			console.log("CryptoCompare TRX price failed:", cryptoCompareError.message);
		}

		// 6. If all sources fail, return a fallback price close to current market
		console.log("⚠️ All TRX price sources failed, using fallback price");
		return "0.33"; // Approximate current TRX price
	} catch (error) {
		console.log("Error in getTRXPrice:", error.message);
		return "0.33"; // Fallback price
	}
};

module.exports = {
	getTRXPrice,
};
