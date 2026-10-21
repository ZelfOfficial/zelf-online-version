/**
 * Standardized Chain Data Formatter
 *
 * This class ensures that all blockchain chains follow the ETH scan format
 * for consistent data structure across the extension and mobile apps.
 *
 * The standardized format includes:
 * - Address information with balance and fiat values
 * - Token holdings with consistent token structure
 * - Transactions with unified fields
 * - Proper error handling and data validation
 */

class StandardizedChainFormatter {
	constructor(chainName, chainSymbol, chainLogo) {
		this.chainName = chainName;
		this.chainSymbol = chainSymbol;
		this.chainLogo = chainLogo;

		// Define the standardized response structure
		this.standardStructure = {
			address: "",
			balance: 0,
			fiatBalance: 0,
			type: "system_account",
			account: {
				asset: "",
				fiatBalance: "0",
				price: "0",
			},
			tokenHoldings: {
				total: 0,
				balance: "0",
				tokens: [],
			},
			transactions: [],
		};
	}

	/**
	 * Format address data to match ETH scan format
	 * @param {Object} rawData - Raw data from chain API
	 * @param {string} address - The wallet address
	 * @param {boolean} wrapInData - Whether to wrap the response in a data object
	 * @returns {Object} Standardized address data
	 */
	formatAddressData(rawData, address, wrapInData = true) {
		try {
			const formatted = {
				address: this.validateAddress(address),
				balance: this.formatBalance(rawData.balance || 0),
				fiatBalance: this.formatFiatBalance(rawData.fiatBalance || 0),
				type: rawData.type || "system_account",
				account: this.formatAccountData(rawData),
				tokenHoldings: this.formatTokenHoldings(rawData.tokenHoldings || rawData.tokens || []),
				transactions: this.formatTransactions(rawData.transactions || []),
			};

			return wrapInData ? { data: formatted } : formatted;
		} catch (error) {
			console.error(`Error formatting address data for ${this.chainName}:`, error);
			const errorResponse = this.getErrorResponse(error.message);
			return wrapInData ? errorResponse : errorResponse.data;
		}
	}

	/**
	 * Format account information
	 * @param {Object} rawData - Raw account data
	 * @returns {Object} Standardized account data
	 */
	formatAccountData(rawData) {
		// Use nativeFiatBalance for account section if available, otherwise fall back to fiatBalance
		const accountFiatBalance = rawData.nativeFiatBalance !== undefined ? rawData.nativeFiatBalance : rawData.fiatBalance;

		return {
			asset: this.chainSymbol,
			fiatBalance: this.formatFiatBalance(accountFiatBalance || 0).toString(),
			price: this.formatPrice(rawData.price || 0).toString(),
		};
	}

	/**
	 * Format token holdings to match ETH scan format
	 * @param {Array} tokens - Array of token data
	 * @returns {Object} Standardized token holdings
	 */
	formatTokenHoldings(tokens) {
		if (!Array.isArray(tokens)) {
			tokens = [];
		}

		const formattedTokens = tokens.map((token) => this.formatToken(token));
		const totalBalance = formattedTokens.reduce((sum, token) => {
			return sum + parseFloat(token.fiatBalance || 0);
		}, 0);

		return {
			total: formattedTokens.length,
			balance: totalBalance.toFixed(6),
			tokens: formattedTokens,
		};
	}

	/**
	 * Format individual token data
	 * @param {Object} token - Raw token data
	 * @returns {Object} Standardized token data
	 */
	formatToken(token) {
		const formatted = {
			_amount: this.formatAmount(token.amount || token._amount || 0),
			_fiatBalance: this.formatFiatBalance(token.fiatBalance || token._fiatBalance || 0).toString(),
			_price: this.formatPrice(token.price || token._price || 0).toString(),
			address: this.validateAddress(token.address || token.address_token || ""),
			amount: this.formatAmount(token.amount || token._amount || 0).toString(),
			decimals: token.decimals || 18,
			fiatBalance: this.formatFiatBalance(token.fiatBalance || token._fiatBalance || 0),
			image: this.validateImageUrl(token.image || token.logoUrl || ""),
			name: token.name || "Unknown Token",
			price: this.formatPrice(token.price || token._price || 0).toString(),
			symbol: token.symbol || "UNKNOWN",
			tokenType: token.tokenType || "ERC-20",
		};

		return formatted;
	}

	/**
	 * Format transactions to match ETH scan format
	 * @param {Array} transactions - Array of transaction data
	 * @returns {Array} Standardized transactions
	 */
	formatTransactions(transactions) {
		if (!Array.isArray(transactions)) {
			return [];
		}

		return transactions.map((tx) => this.formatTransaction(tx));
	}

	/**
	 * Format individual transaction data
	 * @param {Object} tx - Raw transaction data
	 * @returns {Object} Standardized transaction data
	 */
	formatTransaction(tx) {
		const traffic = this.determineTraffic(tx);
		const method = this.determineMethod(tx);
		const fiatAmount = this.calculateFiatAmount(tx);
		const unixTs = this.resolveTransactionUnixTime(tx);

		return {
			hash: this.validateHash(tx.hash || tx.transactionHash || ""),
			method: method,
			block: tx.block || tx.blockNumber || tx.blockHeight || "N/A",
			age: unixTs ? this.calculateAge(unixTs) : tx.age || "Unknown",
			date: unixTs ? this.formatDate(unixTs) : "N/A",
			timestamp: unixTs || 0,
			blocktime: unixTs || 0,
			from: this.validateAddress(tx.from || ""),
			traffic: traffic,
			to: this.validateAddress(tx.to || ""),
			fiatAmount: fiatAmount.toFixed(2),
			amount: this.formatAmountString(tx.amount || tx.value || 0),
			asset: tx.asset || this.chainSymbol,
			txnFee: this.formatAmountString(tx.txnFee || tx.fee || tx.gasUsed || 0),
		};
	}

	resolveTransactionUnixTime(tx) {
		const candidates = [tx.timestamp, tx.blocktime, tx.timeStamp, tx.date];
		for (const candidate of candidates) {
			const unix = this.normalizeUnixTimestampSeconds(candidate);
			if (unix) return unix;
		}
		return 0;
	}

	normalizeUnixTimestampSeconds(value) {
		if (value === null || value === undefined || value === "") return 0;
		if (typeof value === "number" && Number.isFinite(value)) {
			if (value > 1e12) return Math.floor(value / 1000);
			if (value > 1e9) return Math.floor(value);
			return 0;
		}
		const str = String(value).trim();
		if (!str) return 0;
		if (/^\d+$/.test(str)) {
			const n = Number(str);
			if (!Number.isFinite(n)) return 0;
			if (n > 1e12) return Math.floor(n / 1000);
			if (n > 1e9) return Math.floor(n);
			return 0;
		}
		const parsed = Date.parse(str);
		if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
		return 0;
	}

	/**
	 * Determine transaction traffic direction (IN/OUT)
	 * @param {Object} tx - Transaction data
	 * @returns {string} Traffic direction
	 */
	determineTraffic(tx) {
		if (tx.traffic) return tx.traffic;
		if (tx.from && tx.to) {
			// This would need to be compared with the queried address
			// For now, return a default
			return "OUT";
		}
		return "OUT";
	}

	/**
	 * Determine transaction method
	 * @param {Object} tx - Transaction data
	 * @returns {string} Transaction method
	 */
	determineMethod(tx) {
		if (tx.method) return tx.method;
		if (tx.type === "contract" || (tx.input && tx.input !== "0x")) {
			return "Contract Interaction";
		}
		return "Transfer";
	}

	/**
	 * Calculate fiat amount from transaction
	 * @param {Object} tx - Transaction data
	 * @returns {number} Fiat amount
	 */
	calculateFiatAmount(tx) {
		const amount = parseFloat(tx.amount || tx.value || 0);
		const price = parseFloat(tx.price || tx.assetPrice || 0);
		return amount * price;
	}

	/**
	 * Calculate age from timestamp
	 * @param {number|string} timestamp - Transaction timestamp
	 * @returns {string} Age string
	 */
	calculateAge(timestamp) {
		const unixTs = this.normalizeUnixTimestampSeconds(timestamp);
		if (!unixTs) return "Unknown";

		const date = new Date(unixTs * 1000);
		const now = new Date();
		const diffMs = now - date;
		const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

		if (diffDays === 0) return "Today";
		if (diffDays === 1) return "1 day ago";
		if (diffDays < 7) return `${diffDays} days ago`;
		if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
		if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;
		return `${Math.floor(diffDays / 365)} years ago`;
	}

	/**
	 * Format date string
	 * @param {number|string} timestamp - Transaction timestamp
	 * @returns {string} Formatted date
	 */
	formatDate(timestamp) {
		const unixTs = this.normalizeUnixTimestampSeconds(timestamp);
		if (!unixTs) return "N/A";

		try {
			const date = new Date(unixTs * 1000);
			return date.toISOString().replace("T", " ").substring(0, 19);
		} catch (error) {
			return "N/A";
		}
	}

	formatAmountString(amount) {
		if (amount === null || amount === undefined) return "0";
		const raw = typeof amount === "string" ? amount.trim() : String(amount);
		if (!raw) return "0";
		if (/^[-+]?\d+(\.\d+)?$/.test(raw) && !raw.includes("e") && !raw.includes("E")) {
			return raw.replace(/\.?0+$/, "").replace(/\.$/, "") || "0";
		}
		const num = Number(raw);
		if (!Number.isFinite(num)) return "0";
		if (num === 0) return "0";
		const fixed = num.toFixed(18);
		return fixed.replace(/\.?0+$/, "") || "0";
	}

	/**
	 * Validate and format address
	 * @param {string} address - Address to validate
	 * @returns {string} Validated address
	 */
	validateAddress(address) {
		if (!address || typeof address !== "string") {
			return "0x0000000000000000000000000000000000000000";
		}

		// Basic address validation
		if (address.startsWith("0x") && address.length === 42) {
			return address;
		}

		// If it's a valid address without 0x prefix, add it
		if (address.length === 40 && /^[0-9a-fA-F]+$/.test(address)) {
			return `0x${address}`;
		}

		return "0x0000000000000000000000000000000000000000";
	}

	/**
	 * Validate and format hash
	 * @param {string} hash - Hash to validate
	 * @returns {string} Validated hash
	 */
	validateHash(hash) {
		if (!hash || typeof hash !== "string") {
			return "0x0000000000000000000000000000000000000000000000000000000000000000";
		}

		if (hash.startsWith("0x") && hash.length === 66) {
			return hash;
		}

		if (hash.length === 64 && /^[0-9a-fA-F]+$/.test(hash)) {
			return `0x${hash}`;
		}

		return "0x0000000000000000000000000000000000000000000000000000000000000000";
	}

	/**
	 * Validate image URL
	 * @param {string} url - Image URL to validate
	 * @returns {string} Validated image URL
	 */
	validateImageUrl(url) {
		if (!url || typeof url !== "string") {
			return this.chainLogo;
		}

		try {
			new URL(url);
			return url;
		} catch (error) {
			return this.chainLogo;
		}
	}

	/**
	 * Format balance value
	 * @param {number|string} balance - Balance to format
	 * @returns {number} Formatted balance
	 */
	formatBalance(balance) {
		const num = parseFloat(balance);
		return isNaN(num) ? 0 : num;
	}

	/**
	 * Format fiat balance value
	 * @param {number|string} balance - Fiat balance to format
	 * @returns {number} Formatted fiat balance
	 */
	formatFiatBalance(balance) {
		const num = parseFloat(balance);
		return isNaN(num) ? 0 : num;
	}

	/**
	 * Format amount value
	 * @param {number|string} amount - Amount to format
	 * @returns {number} Formatted amount
	 */
	formatAmount(amount) {
		const num = parseFloat(amount);
		return isNaN(num) ? 0 : num;
	}

	/**
	 * Format price value
	 * @param {number|string} price - Price to format
	 * @returns {number} Formatted price
	 */
	formatPrice(price) {
		const num = parseFloat(price);
		return isNaN(num) ? 0 : num;
	}

	/**
	 * Get error response in standardized format
	 * @param {string} errorMessage - Error message
	 * @returns {Object} Standardized error response
	 */
	getErrorResponse(errorMessage) {
		return {
			error: true,
			message: errorMessage,
			chain: this.chainName,
			data: {
				address: "",
				balance: 0,
				fiatBalance: 0,
				type: "error",
				account: {
					asset: this.chainSymbol,
					fiatBalance: "0",
					price: "0",
				},
				tokenHoldings: {
					total: 0,
					balance: "0",
					tokens: [],
				},
				transactions: [],
			},
		};
	}

	/**
	 * Create a standardized response for empty or failed requests
	 * @param {string} address - The wallet address
	 * @returns {Object} Standardized empty response
	 */
	getEmptyResponse(address) {
		return {
			data: {
				address: this.validateAddress(address),
				balance: 0,
				fiatBalance: 0,
				type: "system_account",
				account: {
					asset: this.chainSymbol,
					fiatBalance: "0",
					price: "0",
				},
				tokenHoldings: {
					total: 0,
					balance: "0",
					tokens: [],
				},
				transactions: [],
			},
		};
	}

	/**
	 * Validate the complete response structure
	 * @param {Object} response - Response to validate
	 * @returns {boolean} Whether response is valid
	 */
	validateResponse(response) {
		if (!response || typeof response !== "object") {
			return false;
		}

		const requiredFields = ["address", "balance", "fiatBalance", "type", "account", "tokenHoldings", "transactions"];

		for (const field of requiredFields) {
			if (!(field in response)) {
				return false;
			}
		}

		return true;
	}

	/**
	 * Get chain information
	 * @returns {Object} Chain information
	 */
	getChainInfo() {
		return {
			name: this.chainName,
			symbol: this.chainSymbol,
			logo: this.chainLogo,
		};
	}
}

module.exports = StandardizedChainFormatter;
