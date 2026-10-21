const moment = require("moment");
const { formatEther } = require("ethers");
const config = require("../../../Core/config");
const { generateRandomUserAgent } = require("../../../Core/helpers");

const ETHERSCAN_V2_API = process.env.ETHERSCAN_V2_API || "https://api.etherscan.io/v2/api";
const DEFAULT_TX_TIMEOUT_MS = Number(process.env.EVM_TX_FETCH_TIMEOUT_MS) || 8000;

const normalizeTransactionLimit = (show, defaultLimit = 25) =>
	Math.min(100, Math.max(1, parseInt(String(show), 10) || defaultLimit));

const normalizePage = (page) => {
	const parsed = parseInt(String(page ?? "1"), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
};

const resolveEtherscanApiKey = () => process.env.ETHERSCAN_API_KEY || config?.etherscan?.apiKey || "";

const inferTraffic = (from, to, address) =>
	String(from || "").toLowerCase() === String(address || "").toLowerCase() ? "OUT" : "IN";

const weiToEthAmount = (wei) => {
	try {
		return Number(formatEther(BigInt(String(wei || "0"))));
	} catch {
		return 0;
	}
};

const computeFeeEth = (gasUsed, gasPrice) => {
	try {
		const fee = BigInt(String(gasUsed || "0")) * BigInt(String(gasPrice || "0"));
		return Number(formatEther(fee));
	} catch {
		return 0;
	}
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
	const fiatAmount = Number(amount || 0) * Number(price || 0);
	const ts = Number(timestamp) || 0;

	return {
		hash,
		block: String(block ?? ""),
		from,
		to,
		value: String(amount ?? 0),
		amount: String(amount ?? 0),
		fiatValue: fiatAmount.toFixed(2),
		fiatAmount: fiatAmount.toFixed(2),
		asset,
		method: method || "Transfer",
		traffic,
		txnFee: typeof txnFee === "number" ? txnFee.toFixed(8) : String(txnFee ?? "0"),
		timestamp: ts,
		blocktime: ts,
		date: ts ? moment(ts * 1000).format("YYYY-MM-DD HH:mm:ss") : "",
		age: ts ? moment(ts * 1000).fromNow() : "N/A",
		status: "Success",
	};
};

const mapEtherscanV2Transaction = (tx, address, { asset = "ETH", price = 0 } = {}) => {
	const value = weiToEthAmount(tx.value);
	const timestamp = parseInt(tx.timeStamp, 10) || 0;
	const txnFee = computeFeeEth(tx.gasUsed, tx.gasPrice);

	return buildStandardRow({
		hash: tx.hash,
		block: tx.blockNumber,
		from: tx.from,
		to: tx.to,
		amount: value,
		asset,
		method: tx.methodId ? "Contract Interaction" : "ETH transfer",
		traffic: inferTraffic(tx.from, tx.to, address),
		txnFee,
		timestamp,
		price,
	});
};

const mapRouteScanTransaction = (tx, address, { asset = "ETH", price = 0 } = {}) => {
	const timestamp = Math.floor(new Date(tx.timestamp).getTime() / 1000);
	const value = weiToEthAmount(tx.value);

	return buildStandardRow({
		hash: tx.id,
		block: tx.blockNumber,
		from: tx.from,
		to: tx.to,
		amount: value,
		asset,
		method: value > 0 ? "Transfer" : "Contract Call",
		traffic: inferTraffic(tx.from, tx.to, address),
		txnFee: computeFeeEth(tx.gasUsed, tx.gasPrice),
		timestamp,
		price,
	});
};

const mapRpcTransaction = (tx, address, { asset = "ETH", price = 0 } = {}) => {
	const timestamp = tx.timestamp ? parseInt(tx.timestamp, 16) : 0;

	return buildStandardRow({
		hash: tx.hash,
		block: tx.blockNumber ? parseInt(tx.blockNumber, 16) : "",
		from: tx.from,
		to: tx.to,
		amount: weiToEthAmount(tx.value),
		asset,
		method: tx.input && tx.input !== "0x" ? "Contract Interaction" : "Transfer",
		traffic: inferTraffic(tx.from, tx.to, address),
		txnFee: computeFeeEth(parseInt(tx.gas || "0", 16), parseInt(tx.gasPrice || "0", 16)),
		timestamp,
		price,
	});
};

const mapBlockscoutTransaction = (tx, address, { asset = "ETH", price = 0 } = {}) => {
	const from = resolveBlockscoutAddress(tx.from);
	const to = resolveBlockscoutAddress(tx.to);
	const value = weiToEthAmount(tx.value);
	const timestamp = tx.timestamp ? Math.floor(new Date(tx.timestamp).getTime() / 1000) : 0;
	let txnFee = 0;
	if (tx.fee?.value != null) {
		txnFee = weiToEthAmount(tx.fee.value);
	} else if (tx.gas_used && tx.gas_price) {
		txnFee = computeFeeEth(tx.gas_used, tx.gas_price);
	}

	return buildStandardRow({
		hash: tx.hash,
		block: tx.block ?? tx.block_number,
		from,
		to,
		amount: value,
		asset,
		method: tx.method || (tx.raw_input && tx.raw_input !== "0x" ? "Contract Interaction" : "Transfer"),
		traffic: inferTraffic(from, to, address),
		txnFee,
		timestamp,
		price,
	});
};

const buildListResponse = (transactions, { page, show, total }) => ({
	pagination: {
		records: String(total ?? transactions.length),
		pages: String(Math.max(1, Math.ceil((total ?? transactions.length) / show))),
		page: String(page),
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

const fetchTransactionsFromRouteScan = async (
	httpGet,
	{ chainId, address, limit = 25, timeout = DEFAULT_TX_TIMEOUT_MS }
) => {
	const url = `https://api.routescan.io/v2/network/mainnet/evm/${chainId}/address/${address}/transactions`;
	const { data } = await httpGet(url, { params: { limit }, timeout });

	if (!Array.isArray(data?.items) || data.items.length === 0) {
		throw new Error("routescan_tx_empty");
	}

	return data.items;
};

const BLOCKSCOUT_USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchTransactionsFromBlockscout = async (
	httpGet,
	{ baseUrl, address, limit = 25, timeout = DEFAULT_TX_TIMEOUT_MS, retries = 2 }
) => {
	const normalizedBase = String(baseUrl || "").replace(/\/$/, "");
	const url = `${normalizedBase}/api/v2/addresses/${address}/transactions`;

	let lastError = new Error("blockscout_tx_empty");

	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const { data } = await httpGet(url, {
				timeout,
				headers: { Accept: "application/json", "User-Agent": BLOCKSCOUT_USER_AGENT },
				validateStatus: (status) => status < 500,
			});

			if (!Array.isArray(data?.items) || data.items.length === 0) {
				throw new Error("blockscout_tx_empty");
			}

			return data.items.slice(0, limit);
		} catch (err) {
			lastError = err;
			if (attempt < retries) {
				await sleep(250 * (attempt + 1));
			}
		}
	}

	throw lastError;
};

/**
 * Best-effort recent tx discovery via public JSON-RPC block scans (no indexer API).
 * Only suitable as a last resort for very recent activity.
 */
const fetchTransactionsFromRpcScan = async (
	httpPost,
	{ rpcUrl, address, limit = 10, maxBlocks = 30, timeout = DEFAULT_TX_TIMEOUT_MS }
) => {
	const startedAt = Date.now();
	const owner = String(address).toLowerCase();
	const found = [];

	const { data: headData } = await httpPost(
		rpcUrl,
		{ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
		{ timeout: Math.min(timeout, 4000), headers: { "Content-Type": "application/json" } }
	);

	if (!headData?.result) {
		throw new Error("rpc_scan_head_unavailable");
	}

	let blockNumber = parseInt(headData.result, 16);

	for (let scanned = 0; scanned < maxBlocks && found.length < limit; scanned++, blockNumber--) {
		if (Date.now() - startedAt > timeout) {
			break;
		}

		const blockHex = `0x${blockNumber.toString(16)}`;
		const { data: blockData } = await httpPost(
			rpcUrl,
			{ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: [blockHex, true] },
			{ timeout: Math.min(timeout, 4000), headers: { "Content-Type": "application/json" } }
		);

		const transactions = blockData?.result?.transactions;
		if (!Array.isArray(transactions)) continue;

		const blockTimestamp = parseInt(blockData.result.timestamp, 16);

		for (const tx of transactions) {
			const from = String(tx.from || "").toLowerCase();
			const to = String(tx.to || "").toLowerCase();

			if (from !== owner && to !== owner) continue;

			found.push(
				mapRpcTransaction({ ...tx, timestamp: blockTimestamp }, address, {
					asset: "ETH",
				})
			);

			if (found.length >= limit) break;
		}
	}

	if (!found.length) {
		throw new Error("rpc_scan_tx_empty");
	}

	return found;
};

module.exports = {
	DEFAULT_TX_TIMEOUT_MS,
	ETHERSCAN_V2_API,
	normalizeTransactionLimit,
	normalizePage,
	resolveEtherscanApiKey,
	inferTraffic,
	mapEtherscanV2Transaction,
	mapRouteScanTransaction,
	mapBlockscoutTransaction,
	mapRpcTransaction,
	buildListResponse,
	buildStandardRow,
	fetchTransactionsFromEtherscanV2,
	fetchTransactionsFromRouteScan,
	fetchTransactionsFromBlockscout,
	fetchTransactionsFromRpcScan,
	weiToEthAmount,
};
