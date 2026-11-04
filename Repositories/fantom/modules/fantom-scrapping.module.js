const axios = require("axios");
const moment = require("moment");
const config = require("../../../Core/config");
const { get_ApiKey } = require("../../Solana/modules/oklink");
const { getTickerPrice } = require("../../binance/modules/binance.module");
const StandardizedChainFormatter = require("../../class/standardized-chain-formatter");

// Initialize Sonic formatter (migrated from Fantom)
const sonicFormatter = new StandardizedChainFormatter("Sonic", "SONIC", "https://s2.coinmarketcap.com/static/img/coins/64x64/3513.png");

// Create axios instance with timeout and better error handling
const instance = axios.create({
	timeout: 30000,
	validateStatus: function (status) {
		return status < 500; // Resolve only if status is less than 500
	},
});

const https = require("https");
const agent = new https.Agent({
	rejectUnauthorized: true,
});

// Sonic API endpoints (migrated from Fantom)

const SONIC_RPC = config.fantom.rpcUrl;
const SONIC_API_BASE = "https://api.sonic.network";
const SONICSCAN_API = "https://api.sonicscan.com/api";

// Generate random user agent
const generateRandomUserAgent = () => {
	const userAgents = [
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
		"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
	];
	return userAgents[Math.floor(Math.random() * userAgents.length)];
};

// Helper function to get latest block number
const getLatestBlock = async () => {
	try {
		const response = await instance.post(
			SONIC_RPC,
			{
				jsonrpc: "2.0",
				method: "eth_blockNumber",
				params: [],
				id: 1,
			},
			{
				headers: { "Content-Type": "application/json" },
			}
		);
		return parseInt(response.data.result, 16);
	} catch (error) {
		console.log("Failed to get latest block:", error.message);
		return 0;
	}
};

/**
 * Get comprehensive address information for Sonic (migrated from Fantom)
 * @param {Object} query - Query parameters containing address
 * @returns {Object} Address data with balance, tokens, and transactions
 */
const getAddress = async (query) => {
	try {
		const { address } = query;

		// Add overall timeout to prevent hanging
		const timeoutPromise = new Promise((_, reject) => {
			setTimeout(() => reject(new Error("Sonic API timeout after 8 seconds")), 8000);
		});

		const dataPromise = (async () => {
			if (!address) {
				throw new Error("Address parameter is required");
			}

			// Get SONIC balance from RPC
			let sonicBalance = "0";
			try {
				const balanceResponse = await instance.post(
					SONIC_RPC,
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
				sonicBalance = balanceResponse.data.result ? (parseInt(balanceResponse.data.result, 16) / Math.pow(10, 18)).toString() : "0";
			} catch (error) {
				console.log("Sonic balance fetch failed:", error.message);
			}

			// Get SONIC price (symbol: S)
			let sonicPrice = "0";
			try {
				const priceData = await getTickerPrice({ symbol: "S" });
				sonicPrice = priceData.price || "0";
			} catch (error) {
				console.log("Sonic price fetch failed:", error.message);
			}

			// Calculate fiat balance
			const fiatBalance = parseFloat(sonicBalance) * parseFloat(sonicPrice);

			// Get tokens (with error handling)
			let tokens = [];
			try {
				const tokensData = await getTokens({ address }, { show: "100" });
				tokens = tokensData.tokens || [];
			} catch (error) {
				console.log("Sonic tokens fetch failed:", error.message);
				// Continue with empty tokens array if API fails
			}

			// Add native SONIC token to the beginning of tokens array (like SOL example)
			const nativeSonicToken = {
				tokenType: "SONIC",
				fiatBalance: fiatBalance,
				symbol: "SONIC",
				name: "Sonic",
				price: sonicPrice,
				amount: parseFloat(sonicBalance),
				image: "https://s2.coinmarketcap.com/static/img/coins/64x64/3513.png",
				address: address, // Native token uses the wallet address
				decimals: 18,
			};

			// Insert native token at the beginning
			tokens.unshift(nativeSonicToken);

			// Get transactions with controlled timeout
			let transactions = [];
			try {
				console.log("Fetching transactions with controlled timeout...");

				// Create a timeout promise for transaction fetching
				const transactionTimeoutPromise = new Promise((_, reject) => {
					setTimeout(() => reject(new Error("Transaction fetch timeout")), 4000);
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
				// Add error message as a transaction entry
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
						asset: "SONIC",
						txnFee: "0",
						note: `Transaction fetch failed: ${error.message}`,
					},
				];
			}

			// Skip asset ID fetch to avoid database timeout
			let assetId = null;

			// Prepare raw data for standardization
			const rawData = {
				address,
				balance: sonicBalance,
				fiatBalance: fiatBalance,
				price: sonicPrice,
				type: "system_account",
				tokenHoldings: tokens,
				transactions: transactions,
			};

			// Use standardized formatter to ensure consistent format (without wrapping)
			const formattedResponse = sonicFormatter.formatAddressData(rawData, address, false);

			// Validate the response
			if (!sonicFormatter.validateResponse(formattedResponse)) {
				console.warn("Sonic response validation failed, returning empty response");
				return sonicFormatter.getEmptyResponse(address).data;
			}

			return formattedResponse;
		})();

		return await Promise.race([dataPromise, timeoutPromise]);
	} catch (error) {
		console.error("Sonic getAddress error:", error.message || "Unknown error");
		// Return error response in correct format (without wrapping)
		const errorResponse = sonicFormatter.getErrorResponse(error.message);
		return errorResponse.data;
	}
};

/**
 * Get ERC20 tokens for a Sonic address (migrated from Fantom)
 * @param {Object} params - Parameters containing address
 * @param {Object} query - Query parameters for pagination
 * @returns {Object} Token holdings data
 */
const getTokens = async (params, query) => {
	try {
		const { address } = params;
		const t = Date.now();

		// Use OKLink API for ERC20 tokens (Sonic is EVM compatible)
		const url = `https://www.oklink.com/api/explorer/v2/sonic/addresses/${address}/tokens?offset=0&limit=${query.show || "100"}&t=${t}`;

		const { data } = await axios.get(url, {
			httpsAgent: agent,
			timeout: 10000,
			validateStatus: function (status) {
				return status < 500; // Resolve only if status is less than 500
			},
			headers: {
				"X-Apikey": get_ApiKey().getApiKey(),
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
			},
		});

		if (data.code !== "0" || !data.data) {
			return {
				balance: "0",
				total: 0,
				tokens: [],
			};
		}

		const rawTokens = data.data.hits.map((token) => ({
			address_token: token.tokenContractAddress,
			amount: token.holdingAmount || "0",
			fiatBalance: token.usdValue || 0,
			_fiatBalance: (token.usdValue || 0).toString(),
			image: token.logoUrl || "",
			name: token.coinName || "Unknown",
			price: token.price || "0",
			symbol: token.symbol || "Unknown",
			tokenType: token.symbol,
		}));

		// Use standardized formatter for token holdings
		const tokenHoldings = sonicFormatter.formatTokenHoldings(rawTokens);

		return {
			balance: tokenHoldings.balance,
			total: tokenHoldings.total,
			tokens: tokenHoldings.tokens,
		};
	} catch (error) {
		console.error("Error getting Sonic tokens:", error.message || "Unknown error");
		return {
			balance: "0",
			total: 0,
			tokens: [],
		};
	}
};

/**
 * Get transaction list for a Sonic address (migrated from Fantom)
 * @param {Object} query - Query parameters containing address, page, and show
 * @returns {Array} Array of transactions
 */
const getTransactionsList = async (query) => {
	try {
		const { address, page = "0", show = "100" } = query;

		// Get SONIC price for transaction formatting (symbol: S)
		let price = "0.48060000"; // Default price
		try {
			const { getTickerPrice } = require("../../binance/modules/binance.module");
			const priceData = await getTickerPrice({ symbol: "S" });
			price = priceData.price || "0.48060000";
		} catch (priceError) {
			console.log("Price fetch failed, using default:", priceError.message);
		}

		// Check if address is a contract first
		let isContract = false;
		try {
			const codeResponse = await instance.post(
				SONIC_RPC,
				{
					jsonrpc: "2.0",
					method: "eth_getCode",
					params: [address, "latest"],
					id: 1,
				},
				{
					headers: { "Content-Type": "application/json" },
				}
			);

			const code = codeResponse.data.result;
			isContract = code && code !== "0x";
		} catch (error) {
			console.log("Contract check failed:", error.message);
		}

		// If it's a contract, get contract interactions (logs)
		if (isContract) {
			try {
				const logsResponse = await instance.post(
					SONIC_RPC,
					{
						jsonrpc: "2.0",
						method: "eth_getLogs",
						params: [
							{
								fromBlock: "0x0",
								toBlock: "latest",
								topics: [
									null, // any event signature
									"0x000000000000000000000000" + address.slice(2), // address padded
								],
							},
						],
						id: 1,
					},
					{
						headers: { "Content-Type": "application/json" },
					}
				);

				if (logsResponse.data.result && logsResponse.data.result.length > 0) {
					const logs = logsResponse.data.result;
					const rawTransactions = logs.slice(parseInt(page) * parseInt(show), (parseInt(page) + 1) * parseInt(show)).map((log) => {
						// Contract interactions are always contract type
						const type = "contract";

						// Contract interactions are typically successful if they appear in logs
						const status = "Success";

						return {
							age: moment().fromNow(),
							amount: "0",
							assetPrice: price.toString(),
							block: parseInt(log.blockNumber, 16).toString(),
							confirmations: "1",
							date: "N/A",
							from: "0x" + log.topics[1]?.slice(26) || address,
							gasPrice: "0",
							hash: log.transactionHash || "0x0000000000000000000000000000000000000000000000000000000000000000",
							image: "https://s2.coinmarketcap.com/static/img/coins/64x64/3513.png", // FTM logo
							status: status,
							to: address,
							txnFee: "0",
							type: type,
							note: `Contract interaction #${logs.indexOf(log) + 1} of ${logs.length} total interactions`,
						};
					});

					// Use standardized formatter for transactions
					const transactions = sonicFormatter.formatTransactions(rawTransactions);

					return {
						pagination: { records: transactions.length.toString(), pages: "1", page: "0" },
						transactions: transactions.sort((a, b) => b.timestamp - a.timestamp),
					};
				}
			} catch (logsError) {
				console.log("Contract logs failed:", logsError.message);
			}
		}

		// For Sonic, use RPC transaction count since OKLink doesn't support Sonic yet
		let response;
		let source;

		try {
			console.log("Trying RPC transaction count (OKLink doesn't support Sonic yet)...");
			const countResponse = await getRPCTransactionCount(address, price);
			if (countResponse) {
				response = countResponse;
				source = "rpc_count";
				console.log("Using RPC transaction count for Sonic");
			}
		} catch (countError) {
			console.log("RPC count failed:", countError.message);
		}

		// Add source to response if response exists
		if (response) {
			response.source = source;
			return response;
		}

		// If no transactions found from external APIs, return empty result
		console.log("No transactions found from external APIs");
		return { pagination: { records: "0", pages: "0", page: "0" }, transactions: [] };
	} catch (error) {
		console.error("Error getting Sonic transactions:", error.message || "Unknown error");
		return { pagination: { records: "0", pages: "0", page: "0" }, transactions: [] };
	}
};

/**
 * Get transaction status/details for a Sonic transaction
 * @param {Object} params - Parameters containing transaction ID
 * @returns {Object} Transaction details
 */
const getTransactionStatus = async (params) => {
	try {
		const { id } = params;

		// First try OKLink API
		const t = Date.now();
		const url = `https://www.oklink.com/api/explorer/v1/fantom/transactions/${id}?t=${t}`;

		const { data } = await axios.get(url, {
			httpsAgent: agent,
			timeout: 10000,
			validateStatus: function (status) {
				return status < 500; // Resolve only if status is less than 500
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

		// Fallback to FantomScan scraping
		try {
			const response = await instance.get(`https://ftmscan.com/tx/${id}`, {
				headers: { "user-agent": generateRandomUserAgent() },
			});

			const $ = cheerio.load(response.data);
			const transaction = {
				hash: id,
				status: "success", // Default assumption
				blockNumber: $(".hash-tag").first().text().trim(),
				from: $("span[data-clipboard-text]").first().text().trim(),
				to: $("span[data-clipboard-text]").eq(1).text().trim(),
				value: $(".text-muted").text().trim(),
				gas: "0",
				gasPrice: "0",
				fee: "0",
				timestamp: Date.now(),
			};

			return transaction;
		} catch (scrapingError) {
			console.log("FantomScan scraping failed:", scrapingError.message);
		}

		const errorObj = new Error("transaction_not_found");
		errorObj.status = 404;
		throw errorObj;
	} catch (error) {
		console.error("Error getting Fantom transaction:", error.message || "Unknown error");
		const errorObj = new Error("transaction_not_found");
		errorObj.status = 404;
		throw errorObj;
	}
};

/**
 * Get RPC transaction scanning for Sonic (since OKLink doesn't support Sonic yet)
 * @param {string} address - Address to get transactions for
 * @param {string} page - Page number
 * @param {string} show - Number of transactions to show
 * @param {string} price - SONIC price
 * @returns {Object} Transaction data
 */
const getRPCTransactionScan = async (address, page, show, price) => {
	try {
		// Get latest block number
		const latestBlockResponse = await instance.post(
			SONIC_RPC,
			{
				jsonrpc: "2.0",
				method: "eth_blockNumber",
				params: [],
				id: 1,
			},
			{
				headers: { "Content-Type": "application/json" },
			}
		);

		const latestBlock = parseInt(latestBlockResponse.data.result, 16);
		const transactions = [];

		// Scan recent blocks for transactions involving this address (optimized)
		const blocksToScan = Math.min(100, parseInt(show) * 5); // Reduced for faster scanning
		const startBlock = latestBlock - blocksToScan;

		console.log(`Scanning blocks ${startBlock} to ${latestBlock} for transactions...`);

		for (let i = 0; i < blocksToScan && i < 50; i++) {
			// Limit to 50 blocks max for speed
			const blockNumber = latestBlock - i;
			try {
				const blockResponse = await instance.post(
					SONIC_RPC,
					{
						jsonrpc: "2.0",
						method: "eth_getBlockByNumber",
						params: [`0x${blockNumber.toString(16)}`, true],
						id: 1,
					},
					{
						headers: { "Content-Type": "application/json" },
					}
				);

				if (blockResponse.data.result && blockResponse.data.result.transactions) {
					const relevantTxs = blockResponse.data.result.transactions.filter(
						(tx) => tx.from.toLowerCase() === address.toLowerCase() || (tx.to && tx.to.toLowerCase() === address.toLowerCase())
					);

					for (const tx of relevantTxs) {
						const value = parseInt(tx.value, 16) / Math.pow(10, 18);
						const traffic = tx.from.toLowerCase() === address.toLowerCase() ? "OUT" : "IN";

						// Determine transaction type based on input data
						const type = tx.input && tx.input !== "0x" ? "contract" : "transfer";

						// Determine status (assuming confirmed transactions are successful)
						const status = "Success";

						transactions.push({
							age: moment().fromNow(),
							amount: value.toFixed(6),
							assetPrice: price.toString(),
							block: parseInt(tx.blockNumber, 16).toString(),
							confirmations: "1",
							date: moment().format("YYYY-MM-DD HH:mm:ss"),
							from: tx.from,
							gasPrice: tx.gasPrice ? parseInt(tx.gasPrice, 16).toString() : "0",
							hash: tx.hash,
							image: "https://s2.coinmarketcap.com/static/img/coins/64x64/3513.png",
							status: status,
							to: tx.to,
							txnFee:
								tx.gasUsed && tx.gasPrice ? ((parseFloat(tx.gasUsed) * parseFloat(tx.gasPrice)) / Math.pow(10, 18)).toFixed(8) : "0",
							type: type,
							method: type === "contract" ? "Contract Interaction" : "SONIC transfer",
							asset: "SONIC",
						});
					}
				}
			} catch (blockError) {
				// Continue with next block if one fails
				continue;
			}

			// Limit to prevent too many API calls
			if (transactions.length >= parseInt(show)) {
				break;
			}
		}

		if (transactions.length > 0) {
			// Use standardized formatter for transactions
			const formattedTransactions = sonicFormatter.formatTransactions(transactions);

			return {
				pagination: {
					records: transactions.length.toString(),
					pages: "1",
					page: page,
				},
				transactions: formattedTransactions.sort((a, b) => b.timestamp - a.timestamp),
			};
		}

		return null;
	} catch (error) {
		console.log("RPC transaction scanning failed:", error.message);
		return null;
	}
};

/**
 * Get OKLink transactions for Sonic (following Base pattern)
 * @param {string} address - Address to get transactions for
 * @param {string} page - Page number
 * @param {string} show - Number of transactions to show
 * @param {string} price - SONIC price
 * @returns {Object} Transaction data
 */
const getOKLinkTransactions = async (address, page, show, price) => {
	try {
		const t = Date.now();

		// Use the OKLink endpoint that works for Sonic
		const url = `https://www.oklink.com/api/explorer/v2/sonic/addresses/${address}/transactionsByClassfy/condition?offset=${page}&limit=${show}&address=${address}&nonzeroValue=false&t=${t}`;

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

		// Check if we got a successful response
		if ((data.code === "0" || data.code === 0) && data.data && data.data.hits) {
			console.log(`✅ OKLink API success! Found ${data.data.hits.length} transactions out of ${data.data.total} total`);

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
					gas: "0", // OKLink doesn't provide gas info in this endpoint
					gasPrice: "0",
					nonce: "0",
					input: "0x",
					blocktime: tx.blocktime,
					traffic: traffic,
					method: tx.method || "SONIC transfer",
					status: tx.status === "0x1" ? "Success" : "Failed",
					image: "https://s2.coinmarketcap.com/static/img/coins/64x64/3513.png",
					date: tx.blocktime ? moment(tx.blocktime * 1000).format("YYYY-MM-DD HH:mm:ss") : "N/A",
					age: tx.blocktime ? moment(tx.blocktime * 1000).fromNow() : "N/A",
					txnFee: tx.fee ? parseFloat(tx.fee).toFixed(8) : "0",
					confirmations: "1",
				};
			});

			// Use standardized formatter for transactions
			const transactions = sonicFormatter.formatTransactions(rawTransactions);

			return {
				pagination: {
					records: data.data.total.toString(),
					pages: Math.ceil(data.data.total / parseInt(show)).toString(),
					page: page,
				},
				transactions: transactions,
			};
		} else if (data.code === "5005") {
			// API_DECODE_ERROR - this might mean the endpoint exists but has issues
			console.log("OKLink API returned decode error - endpoint exists but may have issues");
			return null;
		} else {
			// Only log as error if there's actually an error message
			if (data.msg || data.message) {
				console.log(`OKLink API error: ${data.msg || data.message}`);
			} else {
				console.log(`OKLink API returned code ${data.code} with no error message`);
			}
			return null;
		}
	} catch (error) {
		console.log("OKLink transactions failed:", error.message);
		return null;
	}
};

/**
 * Get RPC transaction count fallback (when APIs fail)
 * @param {string} address - Address to get transaction count for
 * @param {string} price - SONIC price
 * @returns {Object} Transaction data with count info
 */
const getRPCTransactionCount = async (address, price) => {
	try {
		// Get transaction count from RPC
		const nonceResponse = await instance.post(
			SONIC_RPC,
			{
				jsonrpc: "2.0",
				method: "eth_getTransactionCount",
				params: [address, "latest"],
				id: 1,
			},
			{
				headers: { "Content-Type": "application/json" },
			}
		);

		const txCount = nonceResponse.data.result ? parseInt(nonceResponse.data.result, 16) : 0;

		// Create a placeholder transaction showing the count
		const placeholderTransaction = {
			age: moment().fromNow(),
			amount: "0",
			assetPrice: price.toString(),
			block: "N/A",
			confirmations: "0",
			date: "N/A",
			from: address,
			gasPrice: "0",
			hash: "0x0000000000000000000000000000000000000000000000000000000000000000",
			image: "https://s2.coinmarketcap.com/static/img/coins/64x64/3513.png", // SONIC logo
			status: "Info",
			to: address,
			txnFee: "0",
			type: "info",
			note: `This address has ${txCount} outgoing transactions. OKLink API is the primary source for Sonic transactions.`,
		};

		return {
			pagination: { records: "1", pages: "1", page: "0" },
			transactions: [placeholderTransaction],
		};
	} catch (error) {
		console.log("RPC transaction count failed:", error.message);
		return null;
	}
};

/**
 * Get gas tracker information for Sonic (migrated from Fantom)
 * @param {Object} query - Query parameters
 * @returns {Object} Gas tracker data
 */
const getGasTracker = async (query) => {
	try {
		// Get gas price from Sonic RPC
		let gasPrice = "1000000000"; // Default 1 gwei
		try {
			const gasResponse = await instance.post(
				SONIC_RPC,
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
			gasPrice = gasResponse.data.result || "1000000000";
		} catch (error) {
			console.log("Sonic gas price fetch failed:", error.message);
		}

		const gasPriceGwei = (parseInt(gasPrice, 16) / Math.pow(10, 9)).toFixed(2);
		const gasPriceUsd = (parseFloat(gasPriceGwei) * 0.000000001 * 0.48).toFixed(6); // Approximate SONIC price

		const response = {
			low: {
				gwei: gasPriceGwei,
				cost: `$${gasPriceUsd}`,
				time: "~5 seconds",
			},
			average: {
				gwei: gasPriceGwei,
				cost: `$${gasPriceUsd}`,
				time: "~5 seconds",
			},
			high: {
				gwei: gasPriceGwei,
				cost: `$${gasPriceUsd}`,
				time: "~5 seconds",
			},
			featuredActions: [
				{
					action: "Transfer SONIC",
					low: `$${gasPriceUsd}`,
					average: `$${gasPriceUsd}`,
					high: `$${gasPriceUsd}`,
				},
			],
		};

		return response;
	} catch (error) {
		console.error("Error getting Sonic gas tracker:", error.message || "Unknown error");
		throw error;
	}
};

module.exports = {
	getAddress,
	getTokens,
	getTransactionsList,
	getTransactionStatus,
	getGasTracker,
};
