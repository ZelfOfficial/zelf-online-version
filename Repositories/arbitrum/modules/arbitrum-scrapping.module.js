const axios = require("axios");
const moment = require("moment");
const https = require("https");
const { get_ApiKey } = require("../../Solana/modules/oklink");
const StandardizedChainFormatter = require("../../class/standardized-chain-formatter");
const { getTickerPrice } = require("../../binance/modules/binance.module");
const { getTokenPrice } = require("../utils/token-pricing");
const { getETHPrice } = require("../utils/eth-price");
const {
	normalizePage,
	formatDecimalString,
	mapEtherscanV2Transaction,
	mapBlockscoutTransaction,
	buildListResponse,
	fetchTransactionsFromEtherscanV2,
	fetchTransactionsFromBlockscout,
	pickBlockscoutCursor,
	runTransactionProviderLadder,
	TX_LIST_DEADLINE_MS,
	DEFAULT_TX_TIMEOUT_MS,
	formatUtcIsoDate,
} = require("../../etherscan/modules/evm-transaction-list.util");

const ARBITRUM_CHAIN_ID = 42161;
const ARBITRUM_BLOCKSCOUT_BASE = process.env.ARBITRUM_BLOCKSCOUT_URL || "https://arbitrum.blockscout.com";

// Initialize Arbitrum formatter
const arbitrumFormatter = new StandardizedChainFormatter("Arbitrum One", "ETH", "https://s2.coinmarketcap.com/static/img/coins/64x64/11841.png");

// Create axios instance with timeout and better error handling
const agent = new https.Agent({
	rejectUnauthorized: false,
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

// Arbitrum API endpoints
const ARBITRUM_RPC = "https://arb1.arbitrum.io/rpc";
const ARBISCAN_API = "https://api.arbiscan.io/api";

/**
 * Get comprehensive address information for Arbitrum One
 */
const getAddress = async (query) => {
	try {
		const { address } = query;

		// Add overall timeout to prevent hanging
		const timeoutPromise = new Promise((_, reject) => {
			setTimeout(() => reject(new Error("Arbitrum API timeout after 8 seconds")), 8000);
		});

		const dataPromise = (async () => {
			// Get ETH balance from RPC
			let ethBalance = "0";
			try {
				const balanceResponse = await instance.post(
					ARBITRUM_RPC,
					{
						jsonrpc: "2.0",
						method: "eth_getBalance",
						params: [address, "latest"],
						id: 1,
					},
					{
						headers: { "Content-Type": "application/json" },
					}
				);
				ethBalance = balanceResponse.data.result ? (parseInt(balanceResponse.data.result, 16) / Math.pow(10, 18)).toString() : "0";
			} catch (error) {
				console.log("Arbitrum balance fetch failed:", error.message);
			}

			// Get ETH price
			let ethPrice = "0";
			try {
				const priceData = await getTickerPrice({ symbol: "ETH" });
				ethPrice = priceData.price || "0";
			} catch (error) {
				console.log("Arbitrum price fetch failed:", error.message);
			}

			// Calculate fiat balance
			const fiatBalance = parseFloat(ethBalance) * parseFloat(ethPrice);

			// Get tokens (with error handling)
			let tokens = [];
			let totalFiatBalance = 0;
			try {
				const tokensData = await getTokens({ address }, { show: "100" });
				tokens = tokensData.tokens || [];
				totalFiatBalance = tokensData.totalFiatBalance || 0;
			} catch (error) {
				console.log("Arbitrum tokens fetch failed:", error.message);
			}

			// Add native ETH token to the beginning of tokens array
			const nativeEthToken = {
				tokenType: "ETH",
				fiatBalance: fiatBalance,
				symbol: "ETH",
				name: "Ethereum",
				price: ethPrice,
				amount: parseFloat(ethBalance),
				image: "https://s2.coinmarketcap.com/static/img/coins/64x64/1027.png",
				address: address,
				decimals: 18,
			};

			// Insert native token at the beginning
			tokens.unshift(nativeEthToken);

			// Get transactions with controlled timeout
			let transactions = [];
			try {
				console.log("Fetching transactions with controlled timeout...");

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
				console.log(`Found ${transactions.length} transactions via OKLink API`);
			} catch (error) {
				console.log("Transaction fetch failed:", error.message);
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
						asset: "ETH",
						txnFee: "0",
						note: `Transaction fetch failed: ${error.message}`,
					},
				];
			}

			// Calculate total portfolio value
			const totalPortfolioValue = fiatBalance + totalFiatBalance;

			// Prepare raw data for standardization
			const rawData = {
				address,
				balance: ethBalance,
				fiatBalance: fiatBalance,
				totalPortfolioValue: totalPortfolioValue,
				price: ethPrice,
				type: "system_account",
				tokenHoldings: tokens,
				transactions: transactions,
			};

			// Use standardized formatter to ensure consistent format
			const formattedResponse = arbitrumFormatter.formatAddressData(rawData, address, false);

			// Validate the response
			if (!arbitrumFormatter.validateResponse(formattedResponse)) {
				console.warn("Arbitrum response validation failed, returning empty response");
				return arbitrumFormatter.getEmptyResponse(address).data;
			}

			return formattedResponse;
		})();

		return await Promise.race([dataPromise, timeoutPromise]);
	} catch (error) {
		console.error("Arbitrum getAddress error:", error.message || "Unknown error");
		const errorResponse = arbitrumFormatter.getErrorResponse(error.message);
		return errorResponse.data;
	}
};

/**
 * Get ERC20 tokens for an Arbitrum One address
 */
const getTokens = async (params, query) => {
	try {
		const { address } = params;
		const t = Date.now();

		// Use OKLink API for ERC20 tokens
		const url = `https://www.oklink.com/api/explorer/v2/arbitrum/addresses/${address}/tokens?offset=0&limit=${query.show || "100"}&t=${t}`;

		const { data } = await axios.get(url, {
			httpsAgent: agent,
			timeout: 5000,
			validateStatus: function (status) {
				return status < 500;
			},
			headers: {
				"X-Apikey": get_ApiKey().getApiKey(),
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
			},
		});

		if ((data.code === "0" || data.code === 0) && data.data && data.data.hits) {
			const rawTokens = data.data.hits.map((token) => ({
				address: token.contractAddress,
				symbol: token.symbol,
				name: token.tokenName,
				decimals: token.decimals || 18,
				amount: (parseFloat(token.holdingAmount) / Math.pow(10, token.decimals || 18)).toString(),
				price: token.price || "0",
				fiatBalance: (parseFloat(token.holdingAmount) * parseFloat(token.price || "0")) / Math.pow(10, token.decimals || 18),
				image: token.logo || "https://s2.coinmarketcap.com/static/img/coins/64x64/11841.png",
				tokenType: "ERC20",
				owner: address,
				contractAddress: token.contractAddress,
				rawAmount: token.holdingAmount,
			}));

			// Calculate total fiat balance across all tokens
			const totalFiatBalance = rawTokens.reduce((sum, token) => sum + (token.fiatBalance || 0), 0);

			// Use standardized formatter for token holdings
			const tokenHoldings = arbitrumFormatter.formatTokenHoldings(rawTokens);

			return {
				balance: tokenHoldings.balance,
				total: tokenHoldings.total,
				totalFiatBalance: totalFiatBalance,
				tokens: tokenHoldings.tokens,
			};
		}

		return {
			balance: "0",
			total: 0,
			tokens: [],
		};
	} catch (error) {
		console.error("Error getting Arbitrum tokens:", error.message || "Unknown error");
		return {
			balance: "0",
			total: 0,
			tokens: [],
		};
	}
};

/**
 * Get transaction list for an Arbitrum One address
 */
const getTransactionsList = async (query) => {
	try {
		const { address, page = "0", show = "100" } = query;
		const deadlineMs = query.deadlineMs || TX_LIST_DEADLINE_MS;

		let price = "3000.00000000";
		try {
			const priceData = await getTickerPrice({ symbol: "ETH" });
			price = priceData.price || "3000.00000000";
		} catch (priceError) {
			console.log("Price fetch failed, using default:", priceError.message);
		}

		const ladderResult = await runTransactionProviderLadder(
			[
				async (timeout) => getOKLinkTransactions(address, page, show, price, timeout),
				async (timeout) => getArbiscanTransactions(address, page, show, price, timeout),
				async (timeout) => getArbitrumBlockscoutTransactions(address, query, show, price, timeout),
			],
			{ deadlineMs }
		);

		if (ladderResult?.transactions?.length) {
			return ladderResult;
		}

		return { pagination: { records: "0", pages: "0", page: "0" }, transactions: [] };
	} catch (error) {
		console.error("Error getting Arbitrum transactions:", error.message || "Unknown error");
		return { pagination: { records: "0", pages: "0", page: "0" }, transactions: [] };
	}
};

/**
 * Get OKLink transactions for Arbitrum One
 */
const getOKLinkTransactions = async (address, page, show, price, timeout = DEFAULT_TX_TIMEOUT_MS) => {
	try {
		const t = Date.now();

		const url = `https://www.oklink.com/api/explorer/v2/arbitrum/addresses/${address}/transactionsByClassfy/condition?offset=${page}&limit=${show}&address=${address}&nonzeroValue=false&t=${t}`;

		const { data } = await axios.get(url, {
			httpsAgent: agent,
			timeout,
			validateStatus: function (status) {
				return status < 500;
			},
			headers: {
				"X-Apikey": get_ApiKey().getApiKey(),
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
			},
		});

		if ((data.code === "0" || data.code === 0) && data.data && data.data.hits) {
			console.log(`✅ OKLink API success! Found ${data.data.hits.length} transactions out of ${data.data.total} total`);

			const rawTransactions = data.data.hits.map((tx) => {
				const value = formatDecimalString(tx.value);
				const priceNum = parseFloat(price);
				const fiatValue = Number(value) * priceNum;
				const traffic = tx.from.toLowerCase() === address.toLowerCase() ? "OUT" : "IN";
				const ts = Number(tx.blocktime) || 0;

				return {
					hash: tx.hash,
					block: tx.blockHeight.toString(),
					from: tx.from,
					to: tx.to,
					value,
					amount: value,
					price: priceNum,
					assetPrice: priceNum,
					fiatValue: fiatValue.toFixed(2),
					fiatAmount: fiatValue.toFixed(2),
					gas: "0",
					gasPrice: "0",
					nonce: "0",
					input: "0x",
					blocktime: ts,
					timestamp: ts,
					traffic: traffic,
					method: tx.method || "ETH transfer",
					status: tx.status === "0x1" ? "Success" : "Failed",
					image: "https://s2.coinmarketcap.com/static/img/coins/64x64/1027.png",
					age: ts ? moment(ts * 1000).fromNow() : "N/A",
					date: formatUtcIsoDate(ts),
					txnFee: tx.fee ? formatDecimalString(tx.fee, 8) : "0",
					asset: "ETH",
					confirmations: "1",
				};
			});

			return {
				source: "oklink",
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
		console.log("OKLink transactions failed:", error.message);
		return null;
	}
};

/**
 * Get Arbiscan transactions
 */
const getArbiscanTransactions = async (address, page, show, price, timeout = DEFAULT_TX_TIMEOUT_MS) => {
	try {
		const etherscanPage = normalizePage(page === "0" ? 1 : page);
		const items = await fetchTransactionsFromEtherscanV2((url, options) => instance.get(url, options), {
			chainId: ARBITRUM_CHAIN_ID,
			address,
			page: etherscanPage,
			offset: parseInt(show, 10) || 25,
			timeout,
		});

		const rawTransactions = items.map((tx) => mapEtherscanV2Transaction(tx, address, { asset: "ETH", price }));
		const transactions = arbitrumFormatter.formatTransactions(rawTransactions);

		return { ...buildListResponse(transactions, { page: etherscanPage, show: parseInt(show, 10) || 25 }), source: "etherscan_v2" };
	} catch (error) {
		console.log("Arbitrum Etherscan V2 transactions failed:", error.message);
		return null;
	}
};

const getArbitrumBlockscoutTransactions = async (address, query, show, price, timeout = DEFAULT_TX_TIMEOUT_MS) => {
	try {
		const limit = parseInt(show, 10) || 25;
		const pageNumber = normalizePage(query.page === "0" ? 1 : query.page);
		const blockscoutPage = await fetchTransactionsFromBlockscout((url, options) => instance.get(url, options), {
			baseUrl: ARBITRUM_BLOCKSCOUT_BASE,
			address,
			limit,
			page: pageNumber,
			cursor: pickBlockscoutCursor(query),
			timeout,
			deadlineMs: timeout,
		});

		if (blockscoutPage.incomplete) {
			return {
				...buildListResponse([], {
					page: pageNumber,
					show: limit,
					incomplete: true,
					hasMore: blockscoutPage.hasMore,
					pagingNote: blockscoutPage.pagingNote,
				}),
				source: "blockscout",
			};
		}

		const rawTransactions = blockscoutPage.items.map((tx) => mapBlockscoutTransaction(tx, address, { asset: "ETH", price }));
		const transactions = arbitrumFormatter.formatTransactions(rawTransactions);

		return {
			...buildListResponse(transactions, {
				page: pageNumber,
				show: limit,
				nextPageParams: blockscoutPage.nextPageParams,
			}),
			source: "blockscout",
		};
	} catch (error) {
		console.log("Arbitrum Blockscout transactions failed:", error.message);
		return null;
	}
};

/**
 * Get transaction status/details for an Arbitrum One transaction
 */
const getTransactionStatus = async (params) => {
	try {
		const { id } = params;

		// First try OKLink API
		const t = Date.now();
		const url = `https://www.oklink.com/api/explorer/v1/arbitrum/transactions/${id}?t=${t}`;

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
				confirmations: tx.confirmations || 0,
				from: tx.from,
				gas: tx.gasUsed,
				gasPrice: tx.gasPrice,
				hash: tx.hash,
				input: tx.input || "0x",
				nonce: tx.nonce,
				to: tx.to,
				transactionIndex: tx.transactionIndex,
				value: (parseFloat(tx.value) / Math.pow(10, 18)).toFixed(6),
				status: tx.status === "1" ? "success" : "failed",
				timestamp: tx.blocktime,
				fee: tx.fee,
			};
		}

		return { error: "Transaction not found" };
	} catch (error) {
		console.error("Error getting Arbitrum transaction status:", error.message || "Unknown error");
		return { error: "Failed to fetch transaction status" };
	}
};

/**
 * Get gas tracker information for Arbitrum One
 */
const getGasTracker = async (query) => {
	try {
		// Fallback: Estimate gas prices from recent blocks
		const response = await instance.post(
			ARBITRUM_RPC,
			{
				jsonrpc: "2.0",
				method: "eth_gasPrice",
				params: [],
				id: 1,
			},
			{
				headers: { "Content-Type": "application/json" },
			}
		);

		const gasPrice = response.data.result ? parseInt(response.data.result, 16) / Math.pow(10, 9) : 0;

		return {
			SafeLow: Math.floor(gasPrice * 0.8),
			Standard: Math.floor(gasPrice),
			Fast: Math.floor(gasPrice * 1.2),
			Fastest: Math.floor(gasPrice * 1.5),
			safeLowWait: "1-2",
			standardWait: "1",
			fastWait: "1",
			fastestWait: "1",
		};
	} catch (error) {
		console.error("Error getting Arbitrum gas tracker:", error.message || "Unknown error");
		return { error: "Failed to fetch gas tracker data" };
	}
};

/**
 * Get portfolio summary for an Arbitrum One address
 */
const getPortfolioSummary = async (params) => {
	try {
		const { address } = params;

		// Get ETH balance and price
		let ethBalance = "0";
		let ethPrice = "0";
		try {
			const balanceResponse = await instance.post(
				ARBITRUM_RPC,
				{
					jsonrpc: "2.0",
					method: "eth_getBalance",
					params: [address, "latest"],
					id: 1,
				},
				{
					headers: { "Content-Type": "application/json" },
				}
			);
			ethBalance = balanceResponse.data.result ? (parseInt(balanceResponse.data.result, 16) / Math.pow(10, 18)).toString() : "0";

			const priceData = await getETHPrice();
			ethPrice = priceData || "0";
		} catch (error) {
			console.log("Portfolio summary ETH data fetch failed:", error.message);
		}

		// Get all tokens
		const tokensData = await getTokens({ address }, { show: "100" });
		const tokens = tokensData.tokens || [];
		const totalTokenValue = tokensData.totalFiatBalance || 0;

		// Calculate total portfolio value
		const ethValue = parseFloat(ethBalance) * parseFloat(ethPrice);
		const totalPortfolioValue = ethValue + totalTokenValue;

		return {
			address,
			totalPortfolioValue: totalPortfolioValue.toFixed(2),
			ethBalance: parseFloat(ethBalance).toFixed(8),
			ethValue: ethValue.toFixed(2),
			ethPrice: ethPrice,
			tokenCount: tokens.length,
			totalTokenValue: totalTokenValue.toFixed(2),
			tokens: tokens,
			lastUpdated: new Date().toISOString(),
		};
	} catch (error) {
		console.error("Error getting Arbitrum portfolio summary:", error.message || "Unknown error");
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
