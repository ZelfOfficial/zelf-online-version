const { formatUnits } = require("ethers");

const fetchBlockscoutErc20Items = async (httpGet, { baseUrl, address, timeout = 8000 }) => {
	const { data } = await httpGet(`${String(baseUrl).replace(/\/$/, "")}/api/v2/addresses/${address}/tokens`, {
		params: { type: "ERC-20" },
		timeout,
	});
	return Array.isArray(data?.items) ? data.items : [];
};

const mapBlockscoutErc20Item = (item) => {
	const token = item?.token;
	if (!token?.address) return null;
	const decimals = parseInt(token.decimals ?? "18", 10);
	const safeDecimals = Number.isInteger(decimals) && decimals >= 0 && decimals <= 255 ? decimals : 18;
	const raw = String(item?.value ?? "0");
	if (!/^\d+$/.test(raw)) return null;

	let amount = "0";
	try {
		amount = formatUnits(BigInt(raw), safeDecimals);
	} catch {
		return null;
	}

	const price = Number(token.exchange_rate || 0);
	const safePrice = Number.isFinite(price) ? price : 0;
	const fiatBalance = Number(amount) * safePrice;

	return {
		address: token.address,
		symbol: token.symbol,
		name: token.name,
		decimals: safeDecimals,
		amount,
		price: String(safePrice),
		fiatBalance: Number.isFinite(fiatBalance) ? fiatBalance : 0,
		image: token.icon_url || "",
		tokenType: token.type || "ERC-20",
		contractAddress: token.address,
	};
};

module.exports = {
	fetchBlockscoutErc20Items,
	mapBlockscoutErc20Item,
};
