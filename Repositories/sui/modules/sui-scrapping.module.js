const moment = require("moment");
const { getTickerPrice } = require("../../binance/modules/binance.module");
const { querySuiGraphql } = require("./sui-graphql.client");
const {
	GRAPHQL_PAGE_MAX,
	SUI_DECIMALS,
	SUI_IMAGE,
	absBigInt,
	coinSymbolFromType,
	formatCoinAmount,
	isNativeSui,
	netGasMist,
	sameAddress,
	shortenCoinType,
	upstreamError,
	wrapUpstream,
} = require("./sui-coin.util");

/**
 * Portfolio reads for /api/sui. Balances, coin metadata, and history come from
 * Sui GraphQL. A failed lookup throws (502); it does not pretend the wallet is empty.
 *
 * `page` is a 0-based page index and `show` is the page size (10, 25, 50, 100),
 * matching the other wallet history endpoints. `pagination.records` stays a string.
 * `hasNextPage` and `nextCursor` are added so clients can follow the GraphQL cursor
 * (`cursor` query param) instead of walking page indexes.
 */

const SUI_COIN = "0x2::sui::SUI";
const MAX_PAGE_INDEX = 50;

const TX_NODE_FIELDS = `
	digest
	sender { address }
	kind { __typename }
	gasInput { gasPrice gasBudget }
	effects {
		status
		timestamp
		checkpoint { sequenceNumber }
		gasEffects { gasSummary { computationCost storageCost storageRebate nonRefundableStorageFee } }
		balanceChanges(first: 50) { nodes { owner { address } amount coinType { repr } } }
	}`;

const BALANCE_FIELDS = `
	coinType { repr }
	totalBalance
	coinMetadata { decimals name symbol iconUrl }`;

const pageIndexOf = (page) => {
	const parsed = Number.parseInt(page, 10);
	if (!Number.isFinite(parsed) || parsed < 0) return 0;
	if (parsed > MAX_PAGE_INDEX) throw upstreamError("sui_page_out_of_range", 400);
	return parsed;
};

const showOf = (show, fallback = 10) => {
	const parsed = Number.parseInt(show, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return Math.min(parsed, 100);
};

const loadSuiPrice = async () => {
	try {
		const quoted = await getTickerPrice({ symbol: "SUI" });
		return quoted?.price ?? "0";
	} catch (_error) {
		console.error("[sui] price_unavailable");
		return "0";
	}
};

const fiatOf = (amount, price) => {
	const left = Number(amount);
	const right = Number(price);
	if (!Number.isFinite(left) || !Number.isFinite(right)) return 0;
	return Number((left * right).toFixed(6));
};

const mapToken = (node, suiPrice) => {
	const repr = node?.coinType?.repr || "";
	const native = isNativeSui(repr);
	const decimals = Number.isInteger(node?.coinMetadata?.decimals) ? node.coinMetadata.decimals : native ? SUI_DECIMALS : null;
	const amount = formatCoinAmount(node?.totalBalance ?? "0", decimals);
	const price = native ? String(suiPrice ?? "0") : "0";
	const fiat = fiatOf(amount, price);
	const symbol = node?.coinMetadata?.symbol || (native ? "SUI" : coinSymbolFromType(repr) || "Unknown");
	const name = node?.coinMetadata?.name || (native ? "Sui" : symbol);
	const icon = node?.coinMetadata?.iconUrl || "";

	return {
		_fiatBalance: String(fiat),
		address_token: native ? "0x2" : shortenCoinType(repr).split("::")[0] || "",
		amount: String(amount),
		coinType: shortenCoinType(repr),
		decimals,
		fiatBalance: fiat,
		image: icon || (native ? SUI_IMAGE : ""),
		name,
		price,
		symbol,
		tokenType: symbol,
	};
};

const fetchBalancePage = async (address, { pageIndex, show }) => {
	const skip = pageIndex * show;
	const need = skip + show;
	const collected = [];
	let after = null;
	let hasMore = true;

	while (collected.length < need && hasMore) {
		const first = Math.min(GRAPHQL_PAGE_MAX, need - collected.length);
		const data = await querySuiGraphql(
			`query SuiCoinBalances($address: SuiAddress!, $first: Int!, $after: String) {
				address(address: $address) {
					balances(first: $first, after: $after) {
						pageInfo { hasNextPage endCursor }
						nodes { ${BALANCE_FIELDS} }
					}
				}
			}`,
			{ address, first, after }
		);
		if (!data?.address) throw upstreamError("sui_graphql_unavailable");
		const connection = data.address.balances || { nodes: [], pageInfo: {} };
		const nodes = connection.nodes || [];
		collected.push(...nodes);
		hasMore = Boolean(connection.pageInfo?.hasNextPage) && nodes.length > 0;
		after = connection.pageInfo?.endCursor || null;
		if (!after) break;
	}

	const tokens = collected.slice(skip, skip + show);
	const hasNextPage = collected.length > skip + tokens.length || (tokens.length === show && hasMore);
	return { nodes: tokens, hasNextPage };
};

const fetchSuiBalance = async (address) => {
	const data = await querySuiGraphql(
		`query SuiNativeBalance($address: SuiAddress!) {
			address(address: $address) {
				balance(coinType: "${SUI_COIN}") { ${BALANCE_FIELDS} }
			}
		}`,
		{ address }
	);
	if (!data?.address) throw upstreamError("sui_graphql_unavailable");
	const node = data.address.balance;
	const decimals = Number.isInteger(node?.coinMetadata?.decimals) ? node.coinMetadata.decimals : SUI_DECIMALS;
	const human = formatCoinAmount(node?.totalBalance ?? "0", decimals);
	return { human, decimals, raw: String(node?.totalBalance ?? "0") };
};

const pickChange = (node, address) => {
	const changes = node?.effects?.balanceChanges?.nodes || [];
	const mine = changes.filter((change) => sameAddress(change?.owner?.address, address));
	if (!mine.length) return null;
	const sui = mine.find((change) => isNativeSui(change?.coinType?.repr) && absBigInt(change.amount) > 0n);
	if (sui) return sui;
	return mine.slice().sort((left, right) => {
		const delta = absBigInt(right?.amount) - absBigInt(left?.amount);
		return delta > 0n ? 1 : delta < 0n ? -1 : 0;
	})[0];
};

const fetchCoinMetadata = async (coinTypes) => {
	const unique = [...new Set(coinTypes)].slice(0, GRAPHQL_PAGE_MAX);
	if (!unique.length) return new Map();
	const declarations = unique.map((_, index) => `$t${index}: String!`).join(", ");
	const fields = unique.map((_, index) => `c${index}: coinMetadata(coinType: $t${index}) { decimals symbol name }`).join("\n");
	const variables = Object.fromEntries(unique.map((coinType, index) => [`t${index}`, coinType]));
	const data = await querySuiGraphql(`query SuiCoinMeta(${declarations}) { ${fields} }`, variables);
	const metadata = new Map();
	unique.forEach((coinType, index) => metadata.set(coinType, data?.[`c${index}`] || null));
	return metadata;
};

const mapTransactionRow = (node, address, suiPrice, metadata) => {
	if (!node?.digest) return null;
	const effects = node.effects || {};
	const primary = pickChange(node, address);
	const repr = primary?.coinType?.repr || "";
	const native = !repr || isNativeSui(repr);
	const meta = metadata.get(repr) || null;
	const decimals = native ? SUI_DECIMALS : Number.isInteger(meta?.decimals) ? meta.decimals : null;
	const human = primary ? formatCoinAmount(primary.amount, decimals) : "0";
	const amount = decimals == null ? human : Number(human).toFixed(6);
	const symbol = native ? "SUI" : meta?.symbol || coinSymbolFromType(repr) || "Unknown";
	const timestamp = Date.parse(effects.timestamp);
	const timestampMs = Number.isFinite(timestamp) ? timestamp : 0;
	const sender = node.sender?.address || "";
	const traffic = sameAddress(sender, address) ? "OUT" : "IN";
	const changes = effects.balanceChanges?.nodes || [];
	const counterparty = changes.find((change) => change?.owner?.address && !sameAddress(change.owner.address, address));
	const summary = effects.gasEffects?.gasSummary;
	const fee = formatCoinAmount(netGasMist(summary).toString(), SUI_DECIMALS);
	const fiat = symbol === "SUI" ? fiatOf(human, suiPrice) : 0;

	return {
		_amount: Number(human) || 0,
		_source: { digest: node.digest },
		age: timestampMs ? moment(timestampMs).fromNow() : "",
		amount,
		asset: symbol,
		block: effects.checkpoint?.sequenceNumber != null ? String(effects.checkpoint.sequenceNumber) : "0",
		date: timestampMs ? moment(timestampMs).format("YYYY-MM-DD HH:mm:ss") : "",
		fiatBalance: fiat,
		from: sender,
		gas: node.gasInput?.gasPrice != null ? String(node.gasInput.gasPrice) : "0",
		hash: node.digest,
		method: node.kind?.__typename || "",
		status: effects.status === "FAILURE" ? "failure" : "success",
		timestamp: timestampMs,
		to: traffic === "OUT" ? counterparty?.owner?.address || "" : address,
		traffic,
		txnFee: fee,
	};
};

const fetchTransactionPage = async (address, { pageIndex, show, cursor }) => {
	const skip = cursor ? 0 : pageIndex * show;
	const need = skip + show;
	const newestFirst = [];
	let before = cursor;
	let hasOlder = true;

	while (newestFirst.length < need && hasOlder) {
		const last = Math.min(GRAPHQL_PAGE_MAX, need - newestFirst.length);
		const data = await querySuiGraphql(
			`query SuiHistory($address: SuiAddress!, $last: Int!, $before: String) {
				transactions(last: $last, before: $before, filter: { affectedAddress: $address }) {
					pageInfo { hasPreviousPage startCursor }
					nodes { ${TX_NODE_FIELDS} }
				}
			}`,
			{ address, last, before }
		);
		const connection = data?.transactions;
		if (!connection) throw upstreamError("sui_graphql_unavailable");
		const nodes = connection.nodes || [];
		newestFirst.push(...[...nodes].reverse());
		hasOlder = Boolean(connection.pageInfo?.hasPreviousPage) && nodes.length > 0;
		before = connection.pageInfo?.startCursor || null;
		if (!before) break;
	}

	const page = newestFirst.slice(skip, skip + show);
	const hasNextPage = newestFirst.length > skip + page.length || (page.length === show && hasOlder);
	return { nodes: page, hasNextPage, nextCursor: hasNextPage ? before : null };
};

const getTokens = async (params, query = {}) => {
	const address = String(params?.id || "").trim();
	if (!address) throw upstreamError("sui_invalid_address", 400);

	try {
		const pageIndex = pageIndexOf(query.page);
		const show = showOf(query.show);
		const [suiPrice, page] = await Promise.all([loadSuiPrice(), fetchBalancePage(address, { pageIndex, show })]);
		const tokens = page.nodes.map((node) => mapToken(node, suiPrice));
		const balance = tokens.reduce((sum, token) => sum + (token.fiatBalance || 0), 0);

		return {
			balance: String(balance),
			hasNextPage: page.hasNextPage,
			total: tokens.length,
			tokens,
		};
	} catch (error) {
		wrapUpstream(error, "sui_tokens_unavailable");
	}
};

const getTransactions = async (params, query = {}) => {
	const address = String(params?.id || "").trim();
	if (!address) throw upstreamError("sui_invalid_address", 400);
	const pageLabel = query.page ?? "0";
	const showLabel = query.show ?? "10";

	try {
		const show = showOf(showLabel);
		const cursor = typeof query.cursor === "string" && query.cursor ? query.cursor : null;
		const pageIndex = cursor ? 0 : pageIndexOf(pageLabel);
		const suiPrice = await loadSuiPrice();
		const page = await fetchTransactionPage(address, { pageIndex, show, cursor });
		const coinTypes = page.nodes.map((node) => pickChange(node, address)?.coinType?.repr).filter((type) => type && !isNativeSui(type));
		const metadata = await fetchCoinMetadata(coinTypes);
		const transactions = page.nodes
			.map((node) => mapTransactionRow(node, address, suiPrice, metadata))
			.filter(Boolean)
			.sort((left, right) => right.timestamp - left.timestamp);
		const records = page.hasNextPage ? String((pageIndex + 1) * show + 1) : String(pageIndex * show + transactions.length);

		return {
			pagination: {
				hasNextPage: page.hasNextPage,
				nextCursor: page.nextCursor,
				page: String(pageLabel),
				records,
				show: String(showLabel),
			},
			transactions,
		};
	} catch (error) {
		wrapUpstream(error, "sui_transactions_unavailable");
	}
};

const getTransaction = async (params) => {
	const digest = String(params?.id || "").trim();
	if (!digest) throw upstreamError("sui_invalid_transaction", 400);

	try {
		const data = await querySuiGraphql(
			`query SuiTransaction($digest: String!) {
				transaction(digest: $digest) { ${TX_NODE_FIELDS} }
			}`,
			{ digest }
		);
		if (!data || !Object.prototype.hasOwnProperty.call(data, "transaction")) throw upstreamError("sui_graphql_unavailable");
		if (!data.transaction) throw upstreamError("transaction_not_found", 404);

		const node = data.transaction;
		const sender = node.sender?.address || "";
		const row = mapTransactionRow(node, sender, "0", new Map());
		const summary = node.effects?.gasEffects?.gasSummary || {};
		return {
			...row,
			computationCostFee: String(summary.computationCost ?? "0"),
			confirmedNumber: row?.block || "0",
			gasBudget: node.gasInput?.gasBudget != null ? String(node.gasInput.gasBudget) : "0",
			gasPayment: "0",
			gasPrice: node.gasInput?.gasPrice != null ? String(node.gasInput.gasPrice) : "0",
			nonRefundableStorageFee: String(summary.nonRefundableStorageFee ?? "0"),
			tokenTransferNum: node.effects?.balanceChanges?.nodes?.length || 0,
			txFee: row?.txnFee || "0",
		};
	} catch (error) {
		wrapUpstream(error, "sui_transaction_unavailable");
	}
};

const getAddress = async (params) => {
	const address = String(params?.id || "").trim();
	if (!address) throw upstreamError("sui_invalid_address", 400);

	try {
		const [suiPrice, suiBalance, tokenPage, history] = await Promise.all([
			loadSuiPrice(),
			fetchSuiBalance(address),
			getTokens({ id: address }, { page: "0", show: "10" }),
			getTransactions({ id: address }, { page: "0", show: "10" }),
		]);

		const tokens = [...(tokenPage.tokens || [])];
		const suiIndex = tokens.findIndex((token) => token.symbol === "SUI" || isNativeSui(token.coinType));
		const pricedSui = mapToken(
			{
				coinType: { repr: `0x${"0".repeat(63)}2::sui::SUI` },
				totalBalance: suiBalance.raw,
				coinMetadata: { decimals: suiBalance.decimals, name: "Sui", symbol: "SUI", iconUrl: tokens[suiIndex]?.image || "" },
			},
			suiPrice
		);
		if (suiIndex >= 0) tokens[suiIndex] = { ...tokens[suiIndex], ...pricedSui, image: tokens[suiIndex].image || pricedSui.image };
		else tokens.unshift(pricedSui);

		const fiatBalance = fiatOf(suiBalance.human, suiPrice);
		const holdingsFiat = tokens.reduce((sum, token) => sum + (token.fiatBalance || 0), 0);

		return {
			_balance: suiBalance.human,
			_fiatBalance: String(fiatBalance),
			address,
			balance: suiBalance.human,
			fiatBalance,
			account: {
				asset: "SUI",
				fiatBalance,
				price: suiPrice,
			},
			tokenHoldings: {
				balance: String(holdingsFiat),
				total: tokens.length,
				tokens,
			},
			transactions: history.transactions || [],
		};
	} catch (error) {
		wrapUpstream(error, "sui_balance_unavailable");
	}
};

module.exports = {
	getAddress,
	getTransaction,
	getTokens,
	getTransactions,
};
