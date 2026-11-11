const moment = require("moment");
const { formatEther } = require("ethers");

const upstreamUnavailableError = (code) => {
	const error = new Error(code);
	error.status = 502;
	return error;
};

const normalizeTransactionLimit = (show, defaultLimit = 100) =>
	Math.min(100, Math.max(1, parseInt(String(show), 10) || defaultLimit));

const inferTraffic = (from, to, address) =>
	String(from || "").toLowerCase() === String(address).toLowerCase() ? "OUT" : "IN";

const formatMethod = (method) => {
	const normalized = String(method || "Transfer");
	return normalized.startsWith("swap") ? "Swap" : normalized;
};

const weiToAvaxAmount = (wei) => {
	try {
		return Number(formatEther(BigInt(String(wei || "0")))).toFixed(4);
	} catch {
		return "0.0000";
	}
};

const computeFeeAvax = (gasUsed, gasPrice) => {
	try {
		const fee = BigInt(String(gasUsed || "0")) * BigInt(String(gasPrice || "0"));
		return Number(formatEther(fee)).toFixed(4);
	} catch {
		return "0.0000";
	}
};

const buildTransactionRow = ({ hash, block, from, to, amount, method, traffic, txnFee, timestamp }) => ({
	age: moment(timestamp * 1000).fromNow(),
	amount,
	asset: "AVAX",
	block: String(block),
	date: moment(timestamp * 1000).format("YYYY-MM-DD HH:mm:ss"),
	from,
	hash,
	method: formatMethod(method),
	to,
	traffic,
	txnFee,
	timestamp,
});

const mapOkLinkTransaction = (tx, address) =>
	buildTransactionRow({
		hash: tx.hash,
		block: tx.blockHeight,
		from: tx.from,
		to: tx.to,
		amount: tx.value.toFixed(4),
		method: tx.method,
		traffic: tx.realValue < 0 ? "OUT" : "IN",
		txnFee: tx.fee.toFixed(4),
		timestamp: tx.blocktime,
	});

const mapRouteScanTransaction = (tx, address) => {
	const timestamp = Math.floor(new Date(tx.timestamp).getTime() / 1000);
	const value = BigInt(tx.value || "0");

	return buildTransactionRow({
		hash: tx.id,
		block: tx.blockNumber,
		from: tx.from,
		to: tx.to,
		amount: weiToAvaxAmount(tx.value),
		method: value > 0n ? "Transfer" : "Contract Call",
		traffic: inferTraffic(tx.from, tx.to, address),
		txnFee: computeFeeAvax(tx.gasUsed, tx.gasPrice),
		timestamp,
	});
};

const mapEtherscanAccountTransaction = (tx, address) => {
	const value = BigInt(tx.value || "0");
	const functionName = String(tx.functionName || "").split("(")[0].trim();
	const method = functionName || (value > 0n ? "Transfer" : "Contract Call");

	return buildTransactionRow({
		hash: tx.hash,
		block: tx.blockNumber,
		from: tx.from,
		to: tx.to,
		amount: weiToAvaxAmount(tx.value),
		method,
		traffic: inferTraffic(tx.from, tx.to, address),
		txnFee: computeFeeAvax(tx.gasUsed, tx.gasPrice),
		timestamp: Number(tx.timeStamp) || 0,
	});
};

const mapGlacierTransaction = (entry, address) => {
	const tx = entry.nativeTransaction || entry;
	const value = BigInt(tx.value || "0");

	return buildTransactionRow({
		hash: tx.txHash,
		block: tx.blockNumber,
		from: tx.from?.address || tx.from,
		to: tx.to?.address || tx.to,
		amount: weiToAvaxAmount(tx.value),
		method: tx.method?.methodName || (value > 0n ? "Transfer" : "Contract Call"),
		traffic: inferTraffic(tx.from?.address || tx.from, tx.to?.address || tx.to, address),
		txnFee: computeFeeAvax(tx.gasUsed, tx.gasPrice),
		timestamp: Number(tx.blockTimestamp),
	});
};

const isOkLinkSuccess = (data) =>
	(data?.code === "0" || data?.code === 0) && Array.isArray(data?.data?.hits);

const sortTransactions = (transactions) => transactions.sort((a, b) => b.timestamp - a.timestamp);

module.exports = {
	upstreamUnavailableError,
	normalizeTransactionLimit,
	mapOkLinkTransaction,
	mapEtherscanAccountTransaction,
	mapRouteScanTransaction,
	mapGlacierTransaction,
	isOkLinkSuccess,
	sortTransactions,
	inferTraffic,
};
