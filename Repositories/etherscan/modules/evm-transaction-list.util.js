const moment = require("moment");
const { formatEther } = require("ethers");
const { generateRandomUserAgent } = require("../../../Core/helpers");

const ETHERSCAN_V2_API = process.env.ETHERSCAN_V2_API || "https://api.etherscan.io/v2/api";
const DEFAULT_TX_TIMEOUT_MS = Number(process.env.EVM_TX_FETCH_TIMEOUT_MS) || 4000;
const TX_LIST_DEADLINE_MS = Number(process.env.EVM_TX_LIST_DEADLINE_MS) || 12000;
const TX_LIST_PROVIDER_TIMEOUT_MS = Number(process.env.EVM_TX_PROVIDER_TIMEOUT_MS) || 4000;
const ETH_ADDRESS_OVERVIEW_TX_CAP_MS = Number(process.env.ETH_ADDRESS_OVERVIEW_TX_CAP_MS) || 3500;

const normalizeTransactionLimit = (show, defaultLimit = 25) =>
	Math.min(100, Math.max(1, parseInt(String(show), 10) || defaultLimit));

const normalizePage = (page) => {
	const parsed = parseInt(String(page ?? "1"), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
};

/** Etherscan V2 only — never fall back to Infura or other keys from Core/config. */
const resolveEtherscanApiKey = () => String(process.env.ETHERSCAN_API_KEY || "").trim();

const isTimeoutError = (err) =>
	err?.code === "ECONNABORTED" ||
	err?.code === "ETIMEDOUT" ||
	/timeout/i.test(String(err?.message || ""));

const inferTraffic = (from, to, address) =>
	String(from || "").toLowerCase() === String(address || "").toLowerCase() ? "OUT" : "IN";

const weiToEthDecimalString = (wei) => {
	try {
		return formatEther(BigInt(String(wei || "0")));
	} catch {
		return "0";
	}
};

const formatDecimalString = (value, maxFractionDigits = 18) => {
	if (value === null || value === undefined) return "0";
	const raw = typeof value === "string" ? value.trim() : String(value);
	if (!raw || raw === "0") return "0";
	if (/^[-+]?\d+$/.test(raw)) return raw;
	const num = Number(raw);
	if (!Number.isFinite(num)) return "0";
	if (num === 0) return "0";
	const fixed = num.toFixed(maxFractionDigits);
	return fixed.replace(/\.?0+$/, "") || "0";
};

const computeFeeEthDecimal = (gasUsed, gasPrice) => {
	try {
		const fee = BigInt(String(gasUsed || "0")) * BigInt(String(gasPrice || "0"));
		return weiToEthDecimalString(fee);
	} catch {
		return "0";
	}
};

const normalizeUnixTimestampSeconds = (value) => {
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
};

const resolveBlockscoutAddress = (field) => {
	if (!field) return "";
	if (typeof field === "string") return field;
	if (typeof field === "object" && field.hash) return field.hash;
	return "";
};

const buildStandardRow = ({
	hash,
	block,
	from,
	to,
	amount,
	asset,
	method,
	traffic,
	txnFee,
	timestamp,
	price,
}) => {
	const ts = normalizeUnixTimestampSeconds(timestamp);
	const amountStr = formatDecimalString(amount);
	const priceNum = Number(price || 0);
	const fiatAmount = (Number(amountStr) * priceNum).toFixed(2);

	return {
		hash,
		block: String(block ?? ""),
		from,
		to,
		value: amountStr,
		amount: amountStr,
		price: priceNum,
		assetPrice: priceNum,
		fiatValue: fiatAmount,
		fiatAmount,
		asset,
		method: method || "Transfer",
		traffic,
		txnFee: formatDecimalString(txnFee, 8),
		timestamp: ts,
		blocktime: ts,
		age: ts ? moment(ts * 1000).fromNow() : "N/A",
		status: "Success",
	};
};

const mapEtherscanV2Transaction = (tx, address, { asset = "ETH", price = 0 } = {}) => {
	const amount = weiToEthDecimalString(tx.value);
	const timestamp = normalizeUnixTimestampSeconds(tx.timeStamp);
	const txnFee = computeFeeEthDecimal(tx.gasUsed, tx.gasPrice);

	return buildStandardRow({
		hash: tx.hash,
		block: tx.blockNumber,
		from: tx.from,
		to: tx.to,
		amount,
		asset,
		method: tx.methodId ? "Contract Interaction" : "ETH transfer",
		traffic: inferTraffic(tx.from, tx.to, address),
		txnFee,
		timestamp,
		price,
	});
};

const mapRouteScanTransaction = (tx, address, { asset = "ETH", price = 0 } = {}) => {
	const timestamp = normalizeUnixTimestampSeconds(tx.timestamp);
	const amount = weiToEthDecimalString(tx.value);

	return buildStandardRow({
		hash: tx.id,
		block: tx.blockNumber,
		from: tx.from,
		to: tx.to,
		amount,
		asset,
		method: BigInt(tx.value || "0") > 0n ? "Transfer" : "Contract Call",
		traffic: inferTraffic(tx.from, tx.to, address),
		txnFee: computeFeeEthDecimal(tx.gasUsed, tx.gasPrice),
		timestamp,
		price,
	});
};

const mapBlockscoutTransaction = (tx, address, { asset = "ETH", price = 0 } = {}) => {
	const from = resolveBlockscoutAddress(tx.from);
	const to = resolveBlockscoutAddress(tx.to);
	const amount = weiToEthDecimalString(tx.value);
	const timestamp = normalizeUnixTimestampSeconds(tx.timestamp);
	let txnFee = "0";

	if (tx.fee?.value != null) {
		txnFee = weiToEthDecimalString(tx.fee.value);
	} else if (tx.gas_used && tx.gas_price) {
		txnFee = computeFeeEthDecimal(tx.gas_used, tx.gas_price);
	}

	return buildStandardRow({
		hash: tx.hash,
		block: tx.block ?? tx.block_number,
		from,
		to,
		amount,
		asset,
		method: tx.method || (tx.raw_input && tx.raw_input !== "0x" ? "Contract Interaction" : "Transfer"),
		traffic: inferTraffic(from, to, address),
		txnFee,
		timestamp,
		price,
	});
};

const buildListResponse = (transactions, { page, show, total, nextCursor, nextPageParams } = {}) => ({
	pagination: {
		records: String(total ?? transactions.length),
		pages: String(Math.max(1, Math.ceil((total ?? transactions.length) / (show || 1)))),
		page: String(page ?? 1),
		...(nextCursor ? { nextCursor: String(nextCursor) } : {}),
		...(nextPageParams ? { nextPageParams } : {}),
	},
	transactions,
});

const fetchTransactionsFromEtherscanV2 = async (
	httpGet,
	{ chainId, address, page = 1, offset = 25, timeout = DEFAULT_TX_TIMEOUT_MS }
) => {
	const apiKey = resolveEtherscanApiKey();
	if (!apiKey) {
		throw new Error("etherscan_api_key_unconfigured");
	}

	const url = `${ETHERSCAN_V2_API}?chainid=${chainId}&module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=${page}&offset=${offset}&sort=desc&apikey=${apiKey}`;
	const { data } = await httpGet(url, {
		timeout,
		headers: { Accept: "application/json", "User-Agent": generateRandomUserAgent() },
		validateStatus: (status) => status < 500,
	});

	if (String(data?.status) !== "1" || !Array.isArray(data?.result) || data.result.length === 0) {
		throw new Error(data?.result || data?.message || "etherscan_v2_tx_empty");
	}

	return data.result;
};

const fetchRouteScanPage = async (httpGet, { chainId, address, limit, nextToken, timeout }) => {
	const url = `https://api.routescan.io/v2/network/mainnet/evm/${chainId}/address/${address}/transactions`;
	const params = { limit };
	if (nextToken) params.next = nextToken;

	const { data } = await httpGet(url, { params, timeout });

	if (!Array.isArray(data?.items) || data.items.length === 0) {
		throw new Error("routescan_tx_empty");
	}

	return {
		items: data.items,
		nextToken: data?.link?.nextToken || data?.link?.next || null,
	};
};

const fetchTransactionsFromRouteScan = async (
	httpGet,
	{ chainId, address, limit = 25, page = 1, nextToken, timeout = DEFAULT_TX_TIMEOUT_MS }
) => {
	const targetPage = normalizePage(page);
	let cursor = nextToken || null;
	let pageResult = null;

	for (let current = 1; current <= targetPage; current++) {
		pageResult = await fetchRouteScanPage(httpGet, {
			chainId,
			address,
			limit,
			nextToken: cursor,
			timeout,
		});

		if (current === targetPage) {
			return pageResult;
		}

		cursor = pageResult.nextToken;
		if (!cursor) {
			throw new Error("routescan_page_unavailable");
		}
	}

	return pageResult;
};

const BLOCKSCOUT_USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";

const fetchBlockscoutPage = async (httpGet, { baseUrl, address, cursor, timeout }) => {
	const normalizedBase = String(baseUrl || "").replace(/\/$/, "");
	const url = `${normalizedBase}/api/v2/addresses/${address}/transactions`;
	const params = cursor && typeof cursor === "object" ? { ...cursor } : {};

	const { data } = await httpGet(url, {
		params,
		timeout,
		headers: { Accept: "application/json", "User-Agent": BLOCKSCOUT_USER_AGENT },
		validateStatus: (status) => status < 500,
	});

	if (!Array.isArray(data?.items) || data.items.length === 0) {
		throw new Error("blockscout_tx_empty");
	}

	return { items: data.items, nextPageParams: data.next_page_params || null };
};

const fetchTransactionsFromBlockscout = async (
	httpGet,
	{ baseUrl, address, limit = 25, page = 1, cursor, timeout = DEFAULT_TX_TIMEOUT_MS }
) => {
	const targetPage = normalizePage(page);
	let pageCursor = cursor || null;
	let pageResult = null;

	for (let current = 1; current <= targetPage; current++) {
		pageResult = await fetchBlockscoutPage(httpGet, {
			baseUrl,
			address,
			cursor: pageCursor,
			timeout,
		});

		if (current === targetPage) {
			return {
				items: pageResult.items.slice(0, limit),
				nextPageParams: pageResult.nextPageParams,
			};
		}

		if (!pageResult.nextPageParams) {
			throw new Error("blockscout_page_unavailable");
		}

		pageCursor = pageResult.nextPageParams;
	}

	return pageResult;
};

const pickBlockscoutCursor = (query = {}) => {
	if (query.blockscoutCursor && typeof query.blockscoutCursor === "object") {
		return query.blockscoutCursor;
	}

	const { block_number, index, hash, inserted_at, fee, items_count } = query;
	if (block_number == null) return null;

	return {
		block_number,
		index,
		hash,
		inserted_at,
		fee,
		items_count,
	};
};

/**
 * Run transaction providers sequentially until one returns rows or the deadline passes.
 */
const runTransactionProviderLadder = async (providers, { deadlineMs = TX_LIST_DEADLINE_MS } = {}) => {
	const startedAt = Date.now();

	for (const provider of providers) {
		const remaining = deadlineMs - (Date.now() - startedAt);
		if (remaining <= 0) break;

		try {
			const attemptTimeout = Math.min(TX_LIST_PROVIDER_TIMEOUT_MS, remaining);
			const result = await provider(attemptTimeout);
			if (result?.transactions?.length) {
				return result;
			}
		} catch (err) {
			if (!isTimeoutError(err)) {
				console.error({ evmTxProviderError: err?.message || err });
			}
		}
	}

	return null;
};

const withTxListDeadline = async (promise, deadlineMs = TX_LIST_DEADLINE_MS) => {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((resolve) => {
				timer = setTimeout(() => resolve(null), deadlineMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
};

module.exports = {
	DEFAULT_TX_TIMEOUT_MS,
	TX_LIST_DEADLINE_MS,
	TX_LIST_PROVIDER_TIMEOUT_MS,
	ETH_ADDRESS_OVERVIEW_TX_CAP_MS,
	ETHERSCAN_V2_API,
	normalizeTransactionLimit,
	normalizePage,
	normalizeUnixTimestampSeconds,
	formatDecimalString,
	resolveEtherscanApiKey,
	isTimeoutError,
	inferTraffic,
	mapEtherscanV2Transaction,
	mapRouteScanTransaction,
	mapBlockscoutTransaction,
	buildListResponse,
	buildStandardRow,
	fetchTransactionsFromEtherscanV2,
	fetchTransactionsFromRouteScan,
	fetchTransactionsFromBlockscout,
	fetchRouteScanPage,
	fetchBlockscoutPage,
	pickBlockscoutCursor,
	runTransactionProviderLadder,
	withTxListDeadline,
	weiToEthDecimalString,
};
