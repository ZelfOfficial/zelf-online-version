const { formatUnits } = require("../../TxNotifications/modules/amount.util");

const SUI_DECIMALS = 9;
const SUI_IMAGE = "https://static.oklink.com/cdn/web3/currency/token/small/784-0x2::sui::SUI-1?v=1742304132417";
const GRAPHQL_PAGE_MAX = 50;

const asBigInt = (value) => {
	const text = String(value ?? "0").trim();
	if (!/^-?\d+$/.test(text)) return 0n;
	return BigInt(text);
};

const absBigInt = (value) => {
	const raw = asBigInt(value);
	return raw < 0n ? -raw : raw;
};

const isNativeSui = (coinType) => {
	const match = /^0x([0-9a-fA-F]+)::sui::SUI$/i.exec(String(coinType || ""));
	return Boolean(match) && /^0*2$/i.test(match[1]);
};

/** `0x000…002::sui::SUI` → `0x2::sui::SUI`. JSON-RPC clients compare the short form. */
const shortenCoinType = (coinType) => {
	const match = /^0x([0-9a-fA-F]+)::(.+)$/.exec(String(coinType || ""));
	if (!match) return String(coinType || "");
	const hex = match[1].replace(/^0+/, "") || "0";
	return `0x${hex}::${match[2]}`;
};

const coinSymbolFromType = (coinType) => {
	const parts = String(coinType || "").split("::");
	return parts.length >= 3 ? parts[parts.length - 1] : "";
};

const normalizeSuiAddress = (value) => {
	const raw = String(value || "").trim().toLowerCase();
	const match = /^0x([0-9a-f]*)$/.exec(raw);
	if (!match) return raw;
	return `0x${match[1].padStart(64, "0")}`;
};

const sameAddress = (left, right) => normalizeSuiAddress(left) === normalizeSuiAddress(right);

const formatCoinAmount = (raw, decimals) => {
	const absolute = absBigInt(raw).toString();
	if (!Number.isInteger(decimals) || decimals < 0) return absolute;
	return formatUnits(absolute, decimals);
};

const netGasMist = (summary) => {
	const net = asBigInt(summary?.computationCost) + asBigInt(summary?.storageCost) - asBigInt(summary?.storageRebate);
	return net > 0n ? net : 0n;
};

const upstreamError = (code, status = 502) => {
	const error = new Error(code);
	error.status = status;
	error.code = code;
	return error;
};

const wrapUpstream = (error, code) => {
	if (error?.status === 400 || error?.status === 404 || error?.status === 409) throw error;
	throw upstreamError(code, 502);
};

module.exports = {
	GRAPHQL_PAGE_MAX,
	SUI_DECIMALS,
	SUI_IMAGE,
	absBigInt,
	asBigInt,
	coinSymbolFromType,
	formatCoinAmount,
	isNativeSui,
	netGasMist,
	normalizeSuiAddress,
	sameAddress,
	shortenCoinType,
	upstreamError,
	wrapUpstream,
};
