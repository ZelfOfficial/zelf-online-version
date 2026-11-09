const { getCleanInstance } = require("../../../Core/axios");
const instance = getCleanInstance(30000);
const { generateRandomUserAgent } = require("../../../Core/helpers");
const moment = require("moment");
const { getTickerPrice } = require("../../binance/modules/binance.module");

const HORIZON_URL = "https://horizon.stellar.org";
const STROOPS_PER_XLM = 10_000_000;
const USD_STABLECOIN_SYMBOLS = new Set(["USDC", "USDT", "DAI", "PYUSD", "USDP", "FDUSD"]);

/**
 * Format stroops integer to XLM decimal string without floating-point drift
 * @param {number|string} stroops
 * @returns {string}
 */
const formatStroopsToXlm = (stroops) => {
	const parsed = parseInt(stroops || 0, 10) || 0;
	if (parsed <= 0) return "0";
	return (parsed / STROOPS_PER_XLM).toFixed(7).replace(/\.?0+$/, "") || "0";
};

/**
 * Resolve USD price for a Stellar asset symbol
 * @param {string} symbol
 * @param {number} xlmPrice
 * @param {Map<string, number>} priceCache
 * @returns {Promise<number>}
 */
const resolveStellarAssetPrice = async (symbol, xlmPrice, priceCache = new Map()) => {
	const normalized = String(symbol || "").trim().toUpperCase();
	if (!normalized) return 0;
	if (priceCache.has(normalized)) return priceCache.get(normalized);

	let resolvedPrice = 0;
	if (normalized === "XLM" || normalized === "YXLM") {
		resolvedPrice = Number(xlmPrice) || 0;
	} else if (USD_STABLECOIN_SYMBOLS.has(normalized)) {
		resolvedPrice = 1;
	} else {
		try {
			const tickerSymbol = normalized === "EURC" ? "EUR" : normalized;
			const { price } = await getTickerPrice({ symbol: tickerSymbol });
			resolvedPrice = parseFloat(price) || 0;
		} catch {
			resolvedPrice = normalized === "EURC" ? 1 : 0;
		}
	}

	priceCache.set(normalized, resolvedPrice);
	return resolvedPrice;
};

/**
 * Extract from/to/amount/asset/type from a Horizon operation
 * @param {Object} op
 * @param {string} [userAddress]
 */
const extractPaymentInfo = (op, userAddress = "") => {
	if (!op) return { from: null, to: null, amount: null, asset: "XLM", operationType: null };

	const opType = op.type || null;

	// Standard payment operation
	if (opType === "payment" && op.to) {
		return {
			from: op.from || op.source_account || null,
			to: op.to,
			amount: parseFloat(op.amount) || null,
			asset: op.asset_type === "native" ? "XLM" : op.asset_code || "XLM",
			operationType: opType,
		};
	}

	// Account creation / initial funding operation
	if (opType === "create_account") {
		return {
			from: op.funder || op.source_account || null,
			to: op.account || null,
			amount: parseFloat(op.starting_balance) || null,
			asset: "XLM",
			operationType: opType,
		};
	}

	// Account merge operation
	if (opType === "account_merge") {
		return {
			from: op.account || op.source_account || null,
			to: op.into || null,
			amount: parseFloat(op.amount) || null,
			asset: "XLM",
			operationType: opType,
		};
	}

	// Path payments (DEX / cross-asset send or receive)
	if (opType === "path_payment_strict_send" || opType === "path_payment_strict_receive") {
		const from = op.from || op.source_account || null;
		const to = op.to || null;
		const isSenderOnly = Boolean(userAddress && from === userAddress && to !== userAddress);
		const rawAmount = isSenderOnly ? op.source_amount || op.amount : op.amount || op.source_amount;
		const assetType = isSenderOnly ? op.source_asset_type || op.asset_type : op.asset_type || op.source_asset_type;
		const assetCode = isSenderOnly ? op.source_asset_code || op.asset_code : op.asset_code || op.source_asset_code;

		return {
			from,
			to,
			amount: parseFloat(rawAmount) || null,
			asset: assetType === "native" ? "XLM" : assetCode || "XLM",
			operationType: opType,
		};
	}

	// Asset balance changes (Soroban contracts, claimable balances, etc.)
	if (op.asset_balance_changes && op.asset_balance_changes.length > 0) {
		const relevantChange =
			(userAddress &&
				op.asset_balance_changes.find((c) => c.to === userAddress || c.from === userAddress)) ||
			op.asset_balance_changes[0];
		const total = op.asset_balance_changes.reduce((sum, c) => sum + (parseFloat(c.amount) || 0), 0);
		return {
			from: relevantChange.from || op.source_account || null,
			to: relevantChange.to || null,
			amount: parseFloat(relevantChange.amount) || total || null,
			asset:
				relevantChange.asset_type === "native"
					? "XLM"
					: relevantChange.asset_code || relevantChange.asset_type || "XLM",
			operationType: opType,
		};
	}

	return {
		from: op.source_account || null,
		to: null,
		amount: null,
		asset: "XLM",
		operationType: opType,
	};
};

/**
 * Select the most relevant operation for userAddress from a transaction's operation list
 * @param {Array<Object>} ops
 * @param {string} [userAddress]
 */
const selectRelevantOperationInfo = (ops, userAddress = "") => {
	if (!Array.isArray(ops) || ops.length === 0) {
		return { from: null, to: null, amount: null, asset: "XLM", operationType: null };
	}

	const parsedOps = ops.map((op) => extractPaymentInfo(op, userAddress));

	if (userAddress) {
		const matchingUserWithAmount = parsedOps.find(
			(info) => (info.to === userAddress || info.from === userAddress) && info.amount !== null
		);
		if (matchingUserWithAmount) return matchingUserWithAmount;

		const matchingUser = parsedOps.find((info) => info.to === userAddress || info.from === userAddress);
		if (matchingUser) return matchingUser;
	}

	const firstWithAmount = parsedOps.find((info) => info.amount !== null || info.to !== null);
	return firstWithAmount || parsedOps[0];
};

/**
 * Fetch operations for a transaction to get from/to/amount/asset
 */
const fetchTransactionOperations = async (txHash, userAddress = "") => {
	try {
		const { data } = await instance.get(
			`${HORIZON_URL}/transactions/${txHash}/operations?limit=20`,
			{ headers: { "user-agent": generateRandomUserAgent() } }
		);
		const ops = data._embedded?.records || [];
		return selectRelevantOperationInfo(ops, userAddress);
	} catch {
		return { from: null, to: null, amount: null, asset: "XLM", operationType: null };
	}
};

/**
 * Format transaction - solo datos relevantes para vista rápida
 */
const formatSingleTransaction = (tx, userAddress, paymentInfo = {}) => {
	try {
		if (!tx || typeof tx !== "object") return null;
		if (!tx._links && tx.hash && typeof tx.traffic !== "undefined") return tx;

		const txDate = moment.utc(tx.created_at);
		const fromAddress = paymentInfo.from || tx.source_account || "";
		const toAddress = paymentInfo.to ?? null;

		let isOutgoing = tx.source_account === userAddress;
		if (userAddress) {
			if (toAddress === userAddress && fromAddress !== userAddress) {
				isOutgoing = false;
			} else if (fromAddress === userAddress) {
				isOutgoing = true;
			}
		}

		const feeXLM = formatStroopsToXlm(tx.fee_charged);

		return {
			hash: tx.hash || tx.id,
			from: fromAddress,
			to: toAddress,
			amount: paymentInfo.amount ?? null,
			asset: paymentInfo.asset ?? "XLM",
			operationType: paymentInfo.operationType ?? null,
			timestamp: txDate.isValid() ? txDate.toISOString() : "",
			date: txDate.isValid() ? txDate.format("YYYY-MM-DD") : "",
			time: txDate.isValid() ? `${txDate.format("HH:mm:ss")} UTC` : "",
			age: txDate.isValid() ? txDate.fromNow() : "",
			fee: feeXLM,
			status: tx.successful ? "Success" : "Failed",
			traffic: isOutgoing ? "OUT" : "IN",
		};
	} catch (err) {
		console.error("Stellar formatSingleTransaction error:", err.message);
		return null;
	}
};

/**
 * Format transactions with payment info (to, amount)
 */
const formatTransactions = async (transactions, userAddress) => {
	if (!Array.isArray(transactions)) return [];

	const opsPromises = transactions.map((tx) =>
		fetchTransactionOperations(tx.hash || tx.id, userAddress)
	);
	const paymentInfos = await Promise.all(opsPromises);

	return transactions
		.map((tx, i) => formatSingleTransaction(tx, userAddress, paymentInfos[i]))
		.filter(Boolean);
};

/**
 * Build empty account response for uninitiated/non-existent Stellar accounts
 */
const emptyAccountResponse = (address) => {
	return {
		address,
		balance: 0,
		type: "account",
		fiatBalance: 0,
		account: {
			asset: "XLM",
			fiatValue: "0.00000",
			price: "0",
		},
		tokenHoldings: {
			total: 0,
			balance: 0,
			fiatBalance: 0,
			tokens: [],
		},
		transactions: [],
		transactionsNext: false,
	};
};

/**
 * Get Stellar account balance, details and transactions
 * Returns empty account (0 balance) when account has not been initiated on Stellar yet
 * @param {Object} params - { id: account_id }
 * @param {Object} query - { limit, show, cursor } for transactions pagination
 * @returns {Object} Account data with balance, token holdings and transactions
 */
const getAddress = async (params, query = {}) => {
	try {
		let data;
		try {
			const res = await instance.get(`${HORIZON_URL}/accounts/${params.id}`, {
				headers: {
					"user-agent": generateRandomUserAgent(),
				},
			});
			data = res.data;
		} catch (horizonError) {
			const status = horizonError.response?.status;
			const errorBody = horizonError.response?.data;
			const errorMsg = typeof errorBody === "object" ? errorBody?.error || errorBody?.detail : String(errorBody || horizonError.message);
			const isNotFound =
				status === 404 ||
				(errorMsg && /not found|could not be found|no data.*could be found/i.test(errorMsg));

			if (isNotFound) {
				return emptyAccountResponse(params.id);
			}
			throw horizonError;
		}

		let xlmBalance = 0;
		const tokenHoldings = {
			total: 0,
			balance: 0,
			fiatBalance: 0,
			tokens: [],
		};

		let xlmPrice = 0;
		try {
			const { price } = await getTickerPrice({ symbol: "XLM" });
			xlmPrice = parseFloat(price) || 0;
		} catch (err) {
			console.error("Stellar getTickerPrice error:", err?.message);
		}

		const priceCache = new Map([["XLM", xlmPrice]]);

		if (data.balances && data.balances.length > 0) {
			for (const balance of data.balances) {
				const balanceValue = parseFloat(balance.balance) || 0;

				if (balance.asset_type === "native") {
					xlmBalance = balanceValue;
					continue;
				}

				const assetCode = balance.asset_code || "UNKNOWN";
				const tokenPrice = await resolveStellarAssetPrice(assetCode, xlmPrice, priceCache);
				const tokenFiat = Number((balanceValue * tokenPrice).toFixed(6));

				const assetInfo = {
					asset: assetCode,
					symbol: assetCode,
					name: assetCode,
					issuer: balance.asset_issuer || null,
					balance: balanceValue,
					amount: balanceValue,
					price: tokenPrice,
					fiatBalance: tokenFiat,
				};

				tokenHoldings.tokens.push(assetInfo);
				tokenHoldings.fiatBalance = Number((tokenHoldings.fiatBalance + tokenFiat).toFixed(6));
			}
			tokenHoldings.total = tokenHoldings.tokens.length;
			tokenHoldings.balance = tokenHoldings.fiatBalance;
		}

		const xlmFiatBalance = xlmBalance * xlmPrice;

		const _response = {
			address: params.id,
			balance: xlmBalance,
			type: data.type || "account",
			fiatBalance: xlmFiatBalance,
			account: {
				asset: "XLM",
				fiatValue: xlmFiatBalance.toFixed(5),
				price: String(xlmPrice),
			},
			tokenHoldings,
			transactions: [],
			transactionsNext: false,
		};

		if (tokenHoldings.fiatBalance) _response.fiatBalance += tokenHoldings.fiatBalance;

		// Include transactions in the response (always return array, empty if none)
		try {
			const transactionsData = await getTransactionsList(params, query);
			_response.transactions = Array.isArray(transactionsData?.transactions)
				? transactionsData.transactions
				: [];
			_response.transactionsNext = Boolean(transactionsData?.next);
		} catch (err) {
			console.error("Stellar transactions fetch error:", err.message);
		}

		return _response;
	} catch (error) {
		console.error({ error });
		throw error;
	}
};

/**
 * Get transactions list for a Stellar account
 * @param {Object} params - { id: account_id }
 * @param {Object} query - { limit, cursor, show }
 * @returns {Object} Transactions list (formatted)
 */
const getTransactionsList = async (params, query) => {
	try {
		// Support both Horizon (limit/cursor) and XRP-style (page/show) params
		const limit = parseInt(query.limit || query.show || 10, 10) || 10;
		const cursor = query.cursor || "";

		let url = `${HORIZON_URL}/accounts/${params.id}/transactions?limit=${limit}&order=desc`;
		if (cursor) url += `&cursor=${cursor}`;

		const { data } = await instance.get(url, {
			headers: {
				"user-agent": generateRandomUserAgent(),
			},
		});

		const rawTransactions = data._embedded?.records || [];
		const accountId = params.id || "";
		const formattedTransactions = await formatTransactions(rawTransactions, accountId);

		return {
			transactions: formattedTransactions,
			next: rawTransactions.length === limit,
		};
	} catch (error) {
		console.error({ error });
		throw error;
	}
};

/**
 * Get single transaction details
 * @param {Object} params - { id: transaction_hash }
 * @returns {Object} Transaction details
 */
const getTransactionDetail = async (params) => {
	try {
		const { data } = await instance.get(`${HORIZON_URL}/transactions/${params.id}`, {
			headers: {
				"user-agent": generateRandomUserAgent(),
			},
		});

		return data;
	} catch (error) {
		console.error({ error });
		throw error;
	}
};

module.exports = {
	getAddress,
	getTransactionsList,
	getTransactionDetail,
	formatStroopsToXlm,
	extractPaymentInfo,
	selectRelevantOperationInfo,
	formatSingleTransaction,
	resolveStellarAssetPrice,
};
