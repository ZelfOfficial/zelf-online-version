const moment = require("moment");
const { formatEther } = require("ethers");
const { generateRandomUserAgent } = require("../../../Core/helpers");

const ETHERSCAN_V2_API = process.env.ETHERSCAN_V2_API || "https://api.etherscan.io/v2/api";
const DEFAULT_TX_TIMEOUT_MS = Number(process.env.EVM_TX_FETCH_TIMEOUT_MS) || 4000;
const TX_LIST_DEADLINE_MS = Number(process.env.EVM_TX_LIST_DEADLINE_MS) || 12000;
const TX_LIST_PROVIDER_TIMEOUT_MS = Number(process.env.EVM_TX_PROVIDER_TIMEOUT_MS) || 4000;
const TX_LIST_PRIMARY_PROVIDER_TIMEOUT_MS = Number(process.env.EVM_TX_PRIMARY_PROVIDER_TIMEOUT_MS) || 7000;
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

const httpStatusFromError = (err) => {
	const status = err?.response?.status ?? err?.status;
	return typeof status === "number" ? status : null;
};

const isWalkPaginationIncompleteError = (err) => {
	if (isTimeoutError(err)) return true;
	if (err?.name === "AbortError" || err?.code === "ABORT_ERR") return true;
	if (/abort/i.test(String(err?.message || "")) || /budget/i.test(String(err?.message || ""))) return true;

	const status = httpStatusFromError(err);
	if (status === 429) return true;
	if (status != null && status >= 500) return true;

	return false;
};

const isWalkEndOfListError = (err) => {
	const message = String(err?.message || "");
	if (
		message === "routescan_tx_empty" ||
		message === "blockscout_tx_empty" ||
		message === "routescan_page_unavailable" ||
		message === "blockscout_page_unavailable"
	) {
		return true;
	}

	const status = httpStatusFromError(err);
	return status != null && status >= 400 && status < 500 && status !== 429;
};

const buildWalkEndOfListRouteScan = (partial = {}) => ({
	items: [],
	nextToken: partial.nextToken ?? null,
});

const buildWalkEndOfListBlockscout = (partial = {}) => ({
	items: [],
	nextPageParams: partial.nextPageParams ?? null,
});

const resolveWalkHopError = (err, partial, kind) => {
	if (isWalkPaginationIncompleteError(err)) {
		if (kind === "blockscout") {
			return {
				...buildWalkBudgetIncomplete({ nextToken: null }),
				nextPageParams: partial.nextPageParams ?? null,
			};
		}
		return buildWalkBudgetIncomplete({ nextToken: partial.nextToken ?? null });
	}

	if (isWalkEndOfListError(err)) {
		return kind === "blockscout" ? buildWalkEndOfListBlockscout(partial) : buildWalkEndOfListRouteScan(partial);
	}

	throw err;
};

const inferTraffic = (from, to, address) =>
	String(from || "").toLowerCase() === String(address || "").toLowerCase() ? "OUT" : "IN";

const weiToEthDecimalString = (wei) => {
	try {
		return formatEther(BigInt(String(wei || "0")));
	} catch {
		return "0";
	}
};

const trimTrailingZeros = (decimal) => {
	if (!decimal.includes(".")) {
		const normalized = decimal.replace(/^\+/, "");
		return normalized || "0";
	}

	const trimmed = decimal.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
	if (!trimmed || trimmed === "-" || trimmed === "+") return "0";
	return trimmed.replace(/^\+/, "");
};

const formatDecimalString = (value, maxFractionDigits = 18) => {
	if (value === null || value === undefined) return "0";
	if (typeof value === "bigint") return formatDecimalString(value.toString(), maxFractionDigits);

	const raw = typeof value === "string" ? value.trim() : String(value);
	if (!raw || raw === "0") return "0";

	if (/^[-+]?\d+$/.test(raw)) {
		return raw.replace(/^\+/, "");
	}

	if (/^[-+]?(\d+)\.(\d+)$/.test(raw) && !/[eE]/.test(raw)) {
		const match = raw.match(/^([-+]?)(\d+)\.(\d+)$/);
		if (!match) return "0";
		const sign = match[1] === "-" ? "-" : "";
		const whole = match[2];
		const fraction = match[3].slice(0, maxFractionDigits);
		return trimTrailingZeros(`${sign}${whole}.${fraction}`);
	}

	if (/[eE]/.test(raw)) {
		try {
			return formatDecimalString(weiToEthDecimalString(BigInt(raw)), maxFractionDigits);
		} catch {
			return "0";
		}
	}

	return "0";
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

const buildListResponse = (
	transactions,
	{ page, show, total, nextCursor, nextPageParams, incomplete, hasMore, pagingNote } = {}
) => ({
	pagination: {
		records: String(total ?? transactions.length),
		pages: String(Math.max(1, Math.ceil((total ?? transactions.length) / (show || 1)))),
		page: String(page ?? 1),
		...(nextCursor ? { nextCursor: String(nextCursor) } : {}),
		...(nextPageParams ? { nextPageParams } : {}),
		...(incomplete ? { incomplete: true } : {}),
		...(hasMore ? { hasMore: true } : {}),
		...(pagingNote ? { pagingNote } : {}),
	},
	...(incomplete ? { incomplete: true } : {}),
	...(hasMore ? { hasMore: true } : {}),
	...(pagingNote ? { pagingNote } : {}),
	transactions,
});

const formatUtcIsoDate = (unixSeconds) => {
	if (!unixSeconds) return "";
	try {
		return new Date(unixSeconds * 1000).toISOString();
	} catch {
		return "";
	}
};

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

const buildWalkBudgetIncomplete = (partial = {}) => ({
	items: [],
	nextToken: partial.nextToken ?? null,
	incomplete: true,
	hasMore: true,
	pagingNote:
		"Transaction list pagination exceeded the time budget before reaching the requested page. Retry or pass pagination.nextCursor from the previous response.",
});

const fetchTransactionsFromRouteScan = async (
	httpGet,
	{
		chainId,
		address,
		limit = 25,
		page = 1,
		nextToken,
		timeout = DEFAULT_TX_TIMEOUT_MS,
		deadlineMs = TX_LIST_DEADLINE_MS,
	}
) => {
	const targetPage = normalizePage(page);
	const cursor = nextToken || null;
	const startedAt = Date.now();

	if (cursor) {
		return fetchRouteScanPage(httpGet, {
			chainId,
			address,
			limit,
			nextToken: cursor,
			timeout,
		});
	}

	if (targetPage === 1) {
		return fetchRouteScanPage(httpGet, {
			chainId,
			address,
			limit,
			nextToken: null,
			timeout,
		});
	}

	let walkCursor = null;
	let pageResult = null;

	for (let current = 1; current <= targetPage; current++) {
		const remaining = deadlineMs - (Date.now() - startedAt);
		if (remaining <= 0) {
			return buildWalkBudgetIncomplete({ nextToken: pageResult?.nextToken ?? null });
		}

		try {
			pageResult = await fetchRouteScanPage(httpGet, {
				chainId,
				address,
				limit,
				nextToken: walkCursor,
				timeout: Math.min(timeout, remaining),
			});
		} catch (err) {
			return resolveWalkHopError(err, { nextToken: pageResult?.nextToken ?? null }, "routescan");
		}

		if (current === targetPage) {
			return pageResult;
		}

		walkCursor = pageResult.nextToken;
		if (!walkCursor) {
			return buildWalkEndOfListRouteScan({ nextToken: null });
		}
	}

	return pageResult;
};

const BLOCKSCOUT_USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";

const classifyBlockscoutHttpStatus = (status) => {
	if (status == null || status < 400) return;

	if (status === 429 || status >= 500) {
		const err = new Error(`blockscout_upstream_${status}`);
		err.response = { status };
		throw err;
	}

	const err = new Error("blockscout_tx_empty");
	err.response = { status };
	throw err;
};

const fetchBlockscoutPage = async (httpGet, { baseUrl, address, cursor, timeout }) => {
	const normalizedBase = String(baseUrl || "").replace(/\/$/, "");
	const url = `${normalizedBase}/api/v2/addresses/${address}/transactions`;
	const params = cursor && typeof cursor === "object" ? { ...cursor } : {};

	const response = await httpGet(url, {
		params,
		timeout,
		headers: { Accept: "application/json", "User-Agent": BLOCKSCOUT_USER_AGENT },
		validateStatus: (status) => status < 500,
	});

	const data = response?.data;
	const status = response?.status;
	classifyBlockscoutHttpStatus(status);

	if (!Array.isArray(data?.items) || data.items.length === 0) {
		throw new Error("blockscout_tx_empty");
	}

	return { items: data.items, nextPageParams: data.next_page_params || null };
};

const fetchTransactionsFromBlockscout = async (
	httpGet,
	{
		baseUrl,
		address,
		limit = 25,
		page = 1,
		cursor,
		timeout = DEFAULT_TX_TIMEOUT_MS,
		deadlineMs = TX_LIST_DEADLINE_MS,
	}
) => {
	const targetPage = normalizePage(page);
	const pageCursor = cursor || null;
	const startedAt = Date.now();

	const finalizeBlockscoutPage = (result) => ({
		items: result.items.slice(0, limit),
		nextPageParams: result.nextPageParams,
	});

	if (pageCursor) {
		return finalizeBlockscoutPage(
			await fetchBlockscoutPage(httpGet, {
				baseUrl,
				address,
				cursor: pageCursor,
				timeout,
			})
		);
	}

	if (targetPage === 1) {
		return finalizeBlockscoutPage(
			await fetchBlockscoutPage(httpGet, {
				baseUrl,
				address,
				cursor: null,
				timeout,
			})
		);
	}

	let walkCursor = null;
	let pageResult = null;

	for (let current = 1; current <= targetPage; current++) {
		const remaining = deadlineMs - (Date.now() - startedAt);
		if (remaining <= 0) {
			return {
				...buildWalkBudgetIncomplete({ nextToken: null }),
				nextPageParams: pageResult?.nextPageParams ?? null,
			};
		}

		try {
			pageResult = await fetchBlockscoutPage(httpGet, {
				baseUrl,
				address,
				cursor: walkCursor,
				timeout: Math.min(timeout, remaining),
			});
		} catch (err) {
			return resolveWalkHopError(
				err,
				{ nextPageParams: pageResult?.nextPageParams ?? null },
				"blockscout"
			);
		}

		if (current === targetPage) {
			return finalizeBlockscoutPage(pageResult);
		}

		if (!pageResult.nextPageParams) {
			return buildWalkEndOfListBlockscout({ nextPageParams: null });
		}

		walkCursor = pageResult.nextPageParams;
	}

	return finalizeBlockscoutPage(pageResult);
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
const resolveProviderTimeout = (providerIndex, remaining, options = {}) => {
	if (typeof options.getProviderTimeout === "function") {
		return Math.min(options.getProviderTimeout(providerIndex, remaining), remaining);
	}

	if (providerIndex === 0 && options.primaryProviderTimeoutMs) {
		return Math.min(options.primaryProviderTimeoutMs, remaining);
	}

	return Math.min(TX_LIST_PROVIDER_TIMEOUT_MS, remaining);
};

const runTransactionProviderLadder = async (providers, options = {}) => {
	const deadlineMs = options.deadlineMs || TX_LIST_DEADLINE_MS;
	const startedAt = Date.now();
	let incompleteFallback = null;

	for (let providerIndex = 0; providerIndex < providers.length; providerIndex++) {
		const provider = providers[providerIndex];
		const remaining = deadlineMs - (Date.now() - startedAt);
		if (remaining <= 0) break;

		try {
			const attemptTimeout = resolveProviderTimeout(providerIndex, remaining, options);
			const result = await provider(attemptTimeout, remaining);
			if (result?.transactions?.length) {
				return result;
			}
			if (result?.incomplete && !incompleteFallback) {
				incompleteFallback = result;
			}
		} catch (err) {
			if (!isTimeoutError(err)) {
				console.error({ evmTxProviderError: err?.message || err });
			}
		}
	}

	return incompleteFallback;
};

/**
 * Run providers in parallel; resolve on the first non-empty result (do not wait for slower peers).
 */
const runTransactionProviderRace = async (providers, options = {}) => {
	const deadlineMs = options.deadlineMs || TX_LIST_DEADLINE_MS;
	const perProviderTimeoutMs = options.perProviderTimeoutMs || TX_LIST_PRIMARY_PROVIDER_TIMEOUT_MS;

	if (!Array.isArray(providers) || providers.length === 0) {
		return null;
	}

	const startedAt = Date.now();
	const remainingMs = () => Math.max(0, deadlineMs - (Date.now() - startedAt));

	return new Promise((resolve) => {
		let settled = false;
		let finished = 0;
		const total = providers.length;

		const settle = (result) => {
			if (settled) return;
			if (result?.transactions?.length) {
				settled = true;
				clearTimeout(deadlineTimer);
				resolve(result);
				return;
			}

			finished++;
			if (finished >= total) {
				settled = true;
				clearTimeout(deadlineTimer);
				resolve(null);
			}
		};

		const deadlineTimer = setTimeout(() => {
			if (!settled) {
				settled = true;
				resolve(null);
			}
		}, deadlineMs);

		providers.forEach((provider) => {
			const timeout = Math.min(perProviderTimeoutMs, deadlineMs);
			if (timeout <= 0) {
				settle(null);
				return;
			}

			Promise.resolve()
				.then(() => provider(timeout, remainingMs()))
				.then((result) => settle(result))
				.catch((err) => {
					if (!isTimeoutError(err)) {
						console.error({ evmTxProviderRaceError: err?.message || err });
					}
					settle(null);
				});
		});
	});
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
	TX_LIST_PRIMARY_PROVIDER_TIMEOUT_MS,
	ETH_ADDRESS_OVERVIEW_TX_CAP_MS,
	ETHERSCAN_V2_API,
	normalizeTransactionLimit,
	normalizePage,
	normalizeUnixTimestampSeconds,
	formatDecimalString,
	formatUtcIsoDate,
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
	runTransactionProviderRace,
	withTxListDeadline,
	weiToEthDecimalString,
};
