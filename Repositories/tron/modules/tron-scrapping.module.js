const axios = require("axios");
const moment = require("moment");
const https = require("https");
const { get_ApiKey } = require("../../Solana/modules/oklink");
const StandardizedChainFormatter = require("../../class/standardized-chain-formatter");
const { getTRXPrice } = require("../utils/trx-price");
const { getTokenPrice } = require("../utils/token-pricing");

// Initialize Tron formatter
const tronFormatter = new StandardizedChainFormatter("Tron", "TRX", "https://s2.coinmarketcap.com/static/img/coins/64x64/1958.png");

// Create axios instance with timeout and better error handling
const agent = new https.Agent({
	rejectUnauthorized: true,
});

const instance = axios.create({
	timeout: 10000,
	httpsAgent: agent,
});

// Generate random user agent
const generateRandomUserAgent = () => {
	const userAgents = [
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
		"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
	];
	return userAgents[Math.floor(Math.random() * userAgents.length)];
};

// Tron API endpoints
const TRON_GRID_API = "https://api.trongrid.io";
const TRONSCAN_API = "https://apilist.tronscanapi.com/api";

/**
 * Get comprehensive address information for Tron
 */
const getAddress = async (query) => {
	try {
		const { address } = query;

		// Add overall timeout to prevent hanging
		const timeoutPromise = new Promise((_, reject) => {
			setTimeout(() => reject(new Error("Tron API timeout after 8 seconds")), 8000);
		});

		const dataPromise = (async () => {
			// Get TRX balance from Tron Grid API
			let trxBalance = "0";
			try {
				const balanceResponse = await instance.post(
					`${TRON_GRID_API}/v1/accounts/${address}`,
					{},
					{
						headers: { "Content-Type": "application/json" },
					}
				);

				if (balanceResponse.data && balanceResponse.data.data && balanceResponse.data.data[0]) {
					const account = balanceResponse.data.data[0];
					trxBalance = account.balance ? (account.balance / Math.pow(10, 6)).toString() : "0";
				}
			} catch (error) {
				// Try alternative method
				try {
					const accountResponse = await instance.get(`${TRONSCAN_API}/account?address=${address}`);
					if (accountResponse.data && accountResponse.data.balance) {
						trxBalance = (accountResponse.data.balance / Math.pow(10, 6)).toString();
					}
				} catch (altError) {}
			}

			// Get TRX price
			let trxPrice = "0";
			try {
				// Try multiple price sources for TRX
				const priceData = await getTRXPrice();
				trxPrice = priceData || "0";
			} catch (error) {}

			// Calculate fiat balance
			const fiatBalance = parseFloat(trxBalance) * parseFloat(trxPrice);

			// Get tokens (with error handling)
			let tokens = [];
			let totalFiatBalance = 0;
			try {
				const tokensData = await getTokens({ address }, { show: "100" });
				tokens = tokensData.tokens || [];
				totalFiatBalance = tokensData.totalFiatBalance || 0;
			} catch (error) {}

			// Add native TRX token to the beginning of tokens array
			const nativeTrxToken = {
				tokenType: "TRX",
				fiatBalance: fiatBalance,
				symbol: "TRX",
				name: "TRON",
				price: trxPrice,
				amount: parseFloat(trxBalance),
				image: "https://s2.coinmarketcap.com/static/img/coins/64x64/1958.png",
				address: address,
				decimals: 6,
			};

			// Insert native token at the beginning
			tokens.unshift(nativeTrxToken);

			// Get transactions with controlled timeout
			let transactions = [];
			try {
				const transactionTimeoutPromise = new Promise((_, reject) => {
					setTimeout(() => reject(new Error("Transaction fetch timeout")), 6000);
				});

				const transactionDataPromise = getTransactionsList({
					address,
					page: "0",
					show: "20",
				});

				const transactionsData = await Promise.race([transactionDataPromise, transactionTimeoutPromise]);
				transactions = transactionsData.transactions || [];
			} catch (error) {
				transactions = [
					{
						hash: "0x" + "0".repeat(64),
						method: "Error",
						block: "N/A",
						age: "N/A",
						date: "N/A",
						from: address,
						traffic: "ERROR",
						to: address,
						fiatAmount: "0.00",
						amount: "0",
						asset: "TRX",
						txnFee: "0",
						note: `Transaction fetch failed: ${error.message}`,
					},
				];
			}

			// Calculate total portfolio value (TRX + all token holdings)
			const totalPortfolioValue = fiatBalance + totalFiatBalance;

			// Prepare raw data for standardization
			const rawData = {
				address,
				balance: trxBalance,
				fiatBalance: totalPortfolioValue, // Total portfolio value for main balance
				nativeFiatBalance: fiatBalance, // TRX-only balance for account section
				totalPortfolioValue: totalPortfolioValue,
				price: trxPrice,
				type: "system_account",
				tokenHoldings: tokens,
				transactions: transactions,
			};

			// Use standardized formatter to ensure consistent format
			const formattedResponse = tronFormatter.formatAddressData(rawData, address, false);

			// Validate the response
			if (!tronFormatter.validateResponse(formattedResponse)) {
				return tronFormatter.getEmptyResponse(address).data;
			}

			return formattedResponse;
		})();

		return await Promise.race([dataPromise, timeoutPromise]);
	} catch (error) {
		const errorResponse = tronFormatter.getErrorResponse(error.message);
		return errorResponse.data;
	}
};

/**
 * Get TRC20 tokens for a Tron address
 */
const getTokens = async (params, query) => {
	try {
		const { address } = params;

		try {
			const fallbackResponse = await instance.get(`${TRONSCAN_API}/account/tokens?address=${address}&start=0&limit=${query.show || "100"}`);

			if (fallbackResponse.data && fallbackResponse.data.data) {
				const rawTokens = await Promise.all(
					fallbackResponse.data.data
						.filter((token) => token.tokenAbbr && token.tokenAbbr.toLowerCase() !== "trx") // Filter out TRX since we handle it separately
						.map(async (token) => {
							// Use our token pricing utility for accurate prices (especially stablecoins)
							const correctedPrice = await getTokenPrice(token.tokenAbbr);
							const amount = parseFloat(token.balance) / Math.pow(10, token.tokenDecimal || 6);

							return {
								address: token.tokenId,
								symbol: token.tokenAbbr,
								name: token.tokenName,
								decimals: token.tokenDecimal || 6,
								amount: amount.toString(),
								price: correctedPrice,
								fiatBalance: amount * parseFloat(correctedPrice),
								image: token.tokenLogo || "https://s2.coinmarketcap.com/static/img/coins/64x64/1958.png",
								tokenType: "TRC20",
								owner: address,
								contractAddress: token.tokenId,
								rawAmount: token.balance,
							};
						})
				);

				const totalFiatBalance = rawTokens.reduce((sum, token) => sum + (token.fiatBalance || 0), 0);
				const tokenHoldings = tronFormatter.formatTokenHoldings(rawTokens);

				return {
					balance: tokenHoldings.balance,
					total: tokenHoldings.total,
					totalFiatBalance: totalFiatBalance,
					tokens: tokenHoldings.tokens,
				};
			}
		} catch (fallbackError) {}

		return {
			balance: "0",
			total: 0,
			tokens: [],
		};
	} catch (error) {
		return {
			balance: "0",
			total: 0,
			tokens: [],
		};
	}
};

/**
 * Get transaction list for a Tron address
 */
const getTransactionsList = async (query) => {
	try {
		const { address, page = "0", show = "100" } = query;

		// Get TRX price for transaction formatting
		let price = "0.33";
		try {
			const priceData = await getTRXPrice();
			price = priceData || "0.33";
		} catch (priceError) {}

		let response;
		let source;

		try {
			const tronScanResponse = await getTronScanTransactions(address, page, show, price);
			if (tronScanResponse && tronScanResponse.transactions && tronScanResponse.transactions.length > 0) {
				response = tronScanResponse;
				source = "tronscan";
			}
		} catch (tronScanError) {
			console.error("TronScan transactions failed:", tronScanError?.message || tronScanError);
		}

		// Add source to response if response exists
		if (response) {
			response.source = source;
			return response;
		}

		// If no transactions found from external APIs, return empty result
		return { pagination: { records: "0", pages: "0", page: "0" }, transactions: [] };
	} catch (error) {
		return { pagination: { records: "0", pages: "0", page: "0" }, transactions: [] };
	}
};

/**
 * Get OKLink transactions for Tron
 */
const getOKLinkTransactions = async (address, page, show, price) => {
	try {
		const t = Date.now();

		const url = `https://www.oklink.com/api/explorer/v2/tron/addresses/${address}/transactionsByClassfy/condition?offset=${page}&limit=${show}&address=${address}&nonzeroValue=false&t=${t}`;

		const { data } = await axios.get(url, {
			httpsAgent: agent,
			timeout: 10000,
			validateStatus: function (status) {
				return status < 500;
			},
			headers: {
				"X-Apikey": get_ApiKey().getApiKey(),
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
			},
		});

		if ((data.code === "0" || data.code === 0) && data.data && data.data.hits) {
			const rawTransactions = data.data.hits.map((tx) => {
				const value = parseFloat(tx.value);
				const fiatValue = value * parseFloat(price);
				const traffic = tx.from.toLowerCase() === address.toLowerCase() ? "OUT" : "IN";

				return {
					hash: tx.hash,
					block: tx.blockHeight.toString(),
					from: tx.from,
					to: tx.to,
					value: value.toString(),
					fiatValue: fiatValue.toFixed(2),
					gas: "0", // Tron uses energy/bandwidth instead of gas
					gasPrice: "0",
					nonce: "0",
					input: "0x",
					blocktime: tx.blocktime,
					timestamp: tx.blocktime,
					traffic: traffic,
					method: tx.method || "TRX transfer",
					status: tx.status === "0x1" ? "Success" : "Failed",
					image: "https://s2.coinmarketcap.com/static/img/coins/64x64/1958.png",
					age: tx.blocktime ? moment(tx.blocktime * 1000).fromNow() : "N/A",
					txnFee: tx.fee ? parseFloat(tx.fee).toFixed(6) : "0",
					confirmations: "1",
					energy: tx.energy || "0",
					bandwidth: tx.bandwidth || "0",
				};
			});

			return {
				pagination: {
					records: data.data.total.toString(),
					pages: Math.ceil(data.data.total / parseInt(show)).toString(),
					page: page,
				},
				transactions: rawTransactions,
			};
		}

		return null;
	} catch (error) {
		return null;
	}
};

/**
 * Get TronScan transactions
 */
const getTronScanTransactions = async (address, page, show, price) => {
	try {
		const start = parseInt(page) * parseInt(show);
		const url = `${TRONSCAN_API}/transaction?sort=-timestamp&count=true&limit=${show}&start=${start}&address=${address}`;

		const { data } = await axios.get(url, {
			timeout: 10000,
			validateStatus: function (status) {
				return status < 500;
			},
			headers: {
				"User-Agent": generateRandomUserAgent(),
				Accept: "application/json",
			},
		});

		if (data && data.data && data.data.length > 0) {
			const rawTransactions = data.data.map((tx) => {
				const value = tx.amount ? parseFloat(tx.amount) / Math.pow(10, 6) : 0;
				const fiatValue = value * parseFloat(price);
				const traffic = tx.ownerAddress === address ? "OUT" : "IN";

				return {
					hash: tx.hash,
					block: tx.block.toString(),
					from: tx.ownerAddress,
					to: tx.toAddress,
					value: value.toString(),
					fiatValue: fiatValue.toFixed(2),
					gas: "0",
					gasPrice: "0",
					nonce: "0",
					input: "0x",
					blocktime: Math.floor(tx.timestamp / 1000),
					traffic: traffic,
					method: tx.contractType ? `${tx.contractType} Contract` : "TRX transfer",
					status: tx.confirmed ? "Success" : "Pending",
					image: "https://s2.coinmarketcap.com/static/img/coins/64x64/1958.png",
					date: moment(tx.timestamp).format("YYYY-MM-DD HH:mm:ss"),
					age: moment(tx.timestamp).fromNow(),
					txnFee: tx.cost ? (tx.cost.net_fee / Math.pow(10, 6)).toFixed(6) : "0",
					confirmations: tx.confirmed ? "1" : "0",
					energy: tx.cost ? tx.cost.energy_usage.toString() : "0",
					bandwidth: tx.cost ? tx.cost.net_usage.toString() : "0",
				};
			});

			const transactions = tronFormatter.formatTransactions(rawTransactions);

			return {
				pagination: {
					records: data.total ? data.total.toString() : transactions.length.toString(),
					pages: data.total ? Math.ceil(data.total / parseInt(show)).toString() : "1",
					page: page,
				},
				transactions: transactions,
			};
		}

		return null;
	} catch (error) {
		return null;
	}
};

/**
 * Get transaction status/details for a Tron transaction
 */
const getTransactionStatus = async (params) => {
	try {
		const { id } = params;

		// First try OKLink API
		const t = Date.now();
		const url = `https://www.oklink.com/api/explorer/v1/tron/transactions/${id}?t=${t}`;

		const { data } = await axios.get(url, {
			httpsAgent: agent,
			timeout: 10000,
			validateStatus: function (status) {
				return status < 500;
			},
			headers: {
				"X-Apikey": get_ApiKey().getApiKey(),
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
			},
		});

		if (data.code === "0" && data.data) {
			const tx = data.data;
			return {
				blockNumber: tx.blockHeight,
				confirmations: tx.confirmations || 1,
				from: tx.from,
				to: tx.to,
				hash: tx.hash,
				value: (parseFloat(tx.value) / Math.pow(10, 6)).toFixed(6),
				status: tx.status === "1" ? "success" : "failed",
				timestamp: tx.blocktime,
				fee: tx.fee,
				energy: tx.energy || "0",
				bandwidth: tx.bandwidth || "0",
			};
		}

		// Fallback to TronScan API
		try {
			const tronScanUrl = `${TRONSCAN_API}/transaction-info?hash=${id}`;
			const response = await instance.get(tronScanUrl, {
				headers: { "user-agent": generateRandomUserAgent() },
				timeout: 10000,
			});

			if (response.data) {
				const tx = response.data;
				return {
					blockNumber: tx.block,
					confirmations: tx.confirmed ? 1 : 0,
					from: tx.ownerAddress,
					to: tx.toAddress,
					value: tx.amount ? (tx.amount / Math.pow(10, 6)).toFixed(6) : "0",
					status: tx.confirmed ? "success" : "pending",
					hash: tx.hash,
					timestamp: Math.floor(tx.timestamp / 1000),
					fee: tx.cost ? (tx.cost.net_fee / Math.pow(10, 6)).toFixed(6) : "0",
					energy: tx.cost ? tx.cost.energy_usage.toString() : "0",
					bandwidth: tx.cost ? tx.cost.net_usage.toString() : "0",
				};
			}
		} catch (tronScanError) {}

		return { error: "Transaction not found" };
	} catch (error) {
		return { error: "Failed to fetch transaction status" };
	}
};

/**
 * Get energy and bandwidth tracker information for Tron
 */
const getGasTracker = async (query) => {
	try {
		// Tron uses energy and bandwidth instead of gas
		// These are more complex than simple gas prices
		return {
			energyPrice: "420", // SUN per energy unit (typical)
			bandwidthPrice: "1000", // SUN per bandwidth unit (typical)
			freezeForEnergy: "1000000", // TRX required to freeze for energy
			freezeForBandwidth: "1000000", // TRX required to freeze for bandwidth
			note: "Tron uses Energy and Bandwidth instead of gas. Users can freeze TRX to obtain these resources.",
			recommendations: {
				lowUsage: "Freeze 100 TRX for basic transactions",
				mediumUsage: "Freeze 1000 TRX for regular DApp usage",
				highUsage: "Freeze 10000 TRX for heavy smart contract interactions",
			},
		};
	} catch (error) {
		return { error: "Failed to fetch energy tracker data" };
	}
};

/**
 * Get portfolio summary for a Tron address
 */
const getPortfolioSummary = async (params) => {
	try {
		const { address } = params;

		// Get TRX balance and price
		let trxBalance = "0";
		let trxPrice = "0";
		try {
			const balanceResponse = await instance.post(
				`${TRON_GRID_API}/v1/accounts/${address}`,
				{},
				{
					headers: { "Content-Type": "application/json" },
				}
			);

			if (balanceResponse.data && balanceResponse.data.data && balanceResponse.data.data[0]) {
				const account = balanceResponse.data.data[0];
				trxBalance = account.balance ? (account.balance / Math.pow(10, 6)).toString() : "0";
			}

			const priceData = await getTRXPrice();
			trxPrice = priceData || "0";
		} catch (error) {}

		// Get all tokens
		const tokensData = await getTokens({ address }, { show: "100" });
		const tokens = tokensData.tokens || [];
		const totalTokenValue = tokensData.totalFiatBalance || 0;

		// Calculate total portfolio value
		const trxValue = parseFloat(trxBalance) * parseFloat(trxPrice);
		const totalPortfolioValue = trxValue + totalTokenValue;

		return {
			address,
			totalPortfolioValue: totalPortfolioValue.toFixed(2),
			trxBalance: parseFloat(trxBalance).toFixed(6),
			trxValue: trxValue.toFixed(2),
			trxPrice: trxPrice,
			tokenCount: tokens.length,
			totalTokenValue: totalTokenValue.toFixed(2),
			tokens: tokens,
			lastUpdated: new Date().toISOString(),
		};
	} catch (error) {
		return { error: "Failed to fetch portfolio summary" };
	}
};

module.exports = {
	getAddress,
	getTokens,
	getTransactionsList,
	getTransactionStatus,
	getGasTracker,
	getPortfolioSummary,
};
