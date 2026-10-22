const { querySuiGraphql } = require("./sui-graphql.client");
const { GRAPHQL_PAGE_MAX, shortenCoinType, upstreamError } = require("./sui-coin.util");

/**
 * JSON-RPC → GraphQL for POST /api/rpc/sui.
 *
 * Sui removed JSON-RPC on mainnet. This translates the read methods the
 * wallet proxy is allowlisted for and that clients actually call. Anything
 * else (execution, dry-run, unsafe builders, object/Move inspection, staking)
 * returns `sui_json_rpc_unavailable` — those responses are not a faithful
 * GraphQL mapping, and a partial object would be worse than a clear error.
 *
 * Supported:
 * - sui_getChainIdentifier → Query.chainIdentifier (genesis checkpoint digest, base58).
 *   This is not the legacy 8-hex prefix JSON-RPC used to return.
 * - sui_getLatestCheckpointSequenceNumber → Checkpoint.sequenceNumber (decimal string).
 * - sui_getBalance / suix_getBalance, sui_getAllBalances / suix_getAllBalances.
 *   `totalBalance` is the exact raw balance. `coinObjectCount` is null: GraphQL
 *   does not count coin objects. `lockedBalance` is always {}.
 * - sui_queryTransactionBlocks / suix_queryTransactionBlocks.
 *   Cursors are GraphQL cursors, not legacy JSON-RPC cursors.
 *   FromAddress → sentAddress. ToAddress and FromOrToAddress → affectedAddress
 *   (sender, sponsor, or recipient). InputObject and ChangedObject → affectedObject.
 * - sui_getCoinMetadata / suix_getCoinMetadata
 * - sui_getReferenceGasPrice / suix_getReferenceGasPrice (decimal string)
 * - sui_getTransactionBlock
 */

const SUI_COIN = "0x2::sui::SUI";

const SUPPORTED_SUI_JSONRPC_METHODS = Object.freeze([
	"sui_getChainIdentifier",
	"sui_getLatestCheckpointSequenceNumber",
	"sui_getBalance",
	"suix_getBalance",
	"sui_getAllBalances",
	"suix_getAllBalances",
	"sui_queryTransactionBlocks",
	"suix_queryTransactionBlocks",
	"sui_getCoinMetadata",
	"suix_getCoinMetadata",
	"sui_getReferenceGasPrice",
	"suix_getReferenceGasPrice",
	"sui_getTransactionBlock",
]);

const TX_FIELDS = `
	digest
	sender { address }
	gasInput { gasPrice gasBudget gasSponsor { address } }
	effects {
		status
		timestamp
		checkpoint { sequenceNumber }
		epoch { epochId }
		gasEffects { gasSummary { computationCost storageCost storageRebate nonRefundableStorageFee } }
		balanceChanges(first: 50) { nodes { owner { address } amount coinType { repr } } }
	}`;

const invalidParams = (reason) => {
	const error = upstreamError("sui_json_rpc_invalid_params", 400);
	error.details = { reason };
	return error;
};

const unavailable = (method) => {
	const error = upstreamError("sui_json_rpc_unavailable", 501);
	error.details = {
		method: String(method || ""),
		supported: SUPPORTED_SUI_JSONRPC_METHODS,
		reason: "Sui removed JSON-RPC. This proxy answers only the read methods listed in supported, via GraphQL.",
	};
	return error;
};

const filterUnsupported = (filter) => {
	const error = upstreamError("sui_json_rpc_filter_unsupported", 400);
	error.details = { filter: String(filter || "") };
	return error;
};

const paramAt = (params, index, objectKey) => {
	if (Array.isArray(params)) return params[index];
	if (params && typeof params === "object") return params[objectKey];
	return undefined;
};

const requireAddress = (value) => {
	const address = String(value || "").trim();
	if (!/^0x[0-9a-fA-F]{1,64}$/.test(address)) throw invalidParams("owner must be a Sui address");
	return address;
};

const balanceResult = (node, fallbackType) => ({
	coinType: shortenCoinType(node?.coinType?.repr || fallbackType || SUI_COIN),
	coinObjectCount: null,
	totalBalance: String(node?.totalBalance ?? "0"),
	lockedBalance: {},
});

const mapTransaction = (node) => {
	if (!node?.digest) return null;
	const effects = node.effects || {};
	const summary = effects.gasEffects?.gasSummary || {};
	const status = effects.status === "SUCCESS" ? "success" : "failure";
	const timestampMs = Number.isFinite(Date.parse(effects.timestamp)) ? String(Date.parse(effects.timestamp)) : null;
	const changes = effects.balanceChanges?.nodes || [];

	return {
		digest: node.digest,
		timestampMs,
		checkpoint: effects.checkpoint?.sequenceNumber != null ? String(effects.checkpoint.sequenceNumber) : null,
		transaction: {
			data: {
				sender: node.sender?.address || null,
				gasData: {
					owner: node.gasInput?.gasSponsor?.address || node.sender?.address || null,
					price: node.gasInput?.gasPrice != null ? String(node.gasInput.gasPrice) : null,
					budget: node.gasInput?.gasBudget != null ? String(node.gasInput.gasBudget) : null,
				},
			},
		},
		effects: {
			messageVersion: "v1",
			status: { status },
			executedEpoch: effects.epoch?.epochId != null ? String(effects.epoch.epochId) : null,
			gasUsed: {
				computationCost: String(summary.computationCost ?? "0"),
				storageCost: String(summary.storageCost ?? "0"),
				storageRebate: String(summary.storageRebate ?? "0"),
				nonRefundableStorageFee: String(summary.nonRefundableStorageFee ?? "0"),
			},
			transactionDigest: node.digest,
		},
		balanceChanges: changes
			.filter((change) => change?.owner?.address)
			.map((change) => ({
				owner: { AddressOwner: change.owner.address },
				coinType: shortenCoinType(change.coinType?.repr),
				amount: String(change.amount ?? "0"),
			})),
	};
};

const moveFunctionName = (value) => {
	if (!value || typeof value !== "object") throw filterUnsupported("MoveFunction");
	const pkg = String(value.package || "").trim();
	const mod = String(value.module || "").trim();
	const fn = String(value.function || "").trim();
	if (!pkg) throw filterUnsupported("MoveFunction");
	if (fn && mod) return `${pkg}::${mod}::${fn}`;
	if (mod) return `${pkg}::${mod}`;
	return pkg;
};

const transactionKind = (value) => {
	const kind = String(value || "");
	if (kind === "ProgrammableTransaction") return "PROGRAMMABLE_TX";
	if (["ChangeEpoch", "Genesis", "ConsensusCommitPrologue", "EndOfEpochTransaction", "SystemTransaction"].includes(kind)) {
		return "SYSTEM_TX";
	}
	throw filterUnsupported(`TransactionKind:${kind}`);
};

/**
 * JSON-RPC TransactionFilter (one key) → GraphQL TransactionFilter.
 * ToAddress has no exact field; affectedAddress is the supported replacement.
 */
const toGraphqlFilter = (filter) => {
	if (filter == null) return null;
	if (typeof filter !== "object" || Array.isArray(filter)) throw filterUnsupported("filter");
	const keys = Object.keys(filter);
	if (!keys.length) return null;
	if (keys.length !== 1) throw filterUnsupported(keys.join(","));

	const key = keys[0];
	const value = filter[key];
	switch (key) {
		case "FromAddress":
			return { sentAddress: requireAddress(value) };
		case "ToAddress":
		case "FromOrToAddress":
			return { affectedAddress: requireAddress(value) };
		case "InputObject":
		case "ChangedObject":
			return { affectedObject: requireAddress(value) };
		case "Checkpoint": {
			const sequence = Number(value);
			if (!Number.isInteger(sequence) || sequence < 0) throw invalidParams("checkpoint must be a sequence number");
			return { atCheckpoint: sequence };
		}
		case "MoveFunction":
			return { function: moveFunctionName(value) };
		case "TransactionKind":
			return { kind: transactionKind(value) };
		default:
			throw filterUnsupported(key);
	}
};

const chainIdentifier = async () => {
	const data = await querySuiGraphql(`query { chainIdentifier }`);
	if (!data?.chainIdentifier) throw upstreamError("sui_graphql_unavailable");
	return String(data.chainIdentifier);
};

const latestCheckpoint = async () => {
	const data = await querySuiGraphql(`query { checkpoint { sequenceNumber } }`);
	const sequence = data?.checkpoint?.sequenceNumber;
	if (sequence == null) throw upstreamError("sui_graphql_unavailable");
	return String(sequence);
};

const getBalance = async (params) => {
	const owner = requireAddress(paramAt(params, 0, "owner"));
	const coinType = String(paramAt(params, 1, "coinType") || SUI_COIN);
	const data = await querySuiGraphql(
		`query SuiBalance($address: SuiAddress!, $coinType: String!) {
			address(address: $address) {
				balance(coinType: $coinType) { coinType { repr } totalBalance }
			}
		}`,
		{ address: owner, coinType }
	);
	if (!data?.address) throw upstreamError("sui_graphql_unavailable");
	return balanceResult(data.address.balance, coinType);
};

const getAllBalances = async (params) => {
	const owner = requireAddress(paramAt(params, 0, "owner"));
	const balances = [];
	let after = null;
	let guard = 0;

	while (guard < 10) {
		guard += 1;
		const data = await querySuiGraphql(
			`query SuiBalances($address: SuiAddress!, $after: String) {
				address(address: $address) {
					balances(first: ${GRAPHQL_PAGE_MAX}, after: $after) {
						pageInfo { hasNextPage endCursor }
						nodes { coinType { repr } totalBalance }
					}
				}
			}`,
			{ address: owner, after }
		);
		const connection = data?.address?.balances;
		if (!data?.address || !connection) throw upstreamError("sui_graphql_unavailable");
		for (const node of connection.nodes || []) balances.push(balanceResult(node));
		if (!connection.pageInfo?.hasNextPage || !connection.pageInfo.endCursor) break;
		after = connection.pageInfo.endCursor;
	}

	return balances;
};

const queryTransactionBlocks = async (params) => {
	const query = paramAt(params, 0, "query") || {};
	const cursor = paramAt(params, 1, "cursor") || null;
	const limitRaw = paramAt(params, 2, "limit");
	const descending = paramAt(params, 3, "descendingOrder") === true;
	const limit = Math.min(GRAPHQL_PAGE_MAX, Math.max(1, Number(limitRaw) || GRAPHQL_PAGE_MAX));
	const filter = toGraphqlFilter(query.filter ?? query.Filter ?? null);

	const data = await querySuiGraphql(
		`query SuiTxBlocks($first: Int, $after: String, $last: Int, $before: String, $filter: TransactionFilter) {
			transactions(first: $first, after: $after, last: $last, before: $before, filter: $filter) {
				pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
				nodes { ${TX_FIELDS} }
			}
		}`,
		descending
			? { last: limit, before: cursor, first: null, after: null, filter }
			: { first: limit, after: cursor, last: null, before: null, filter }
	);

	const connection = data?.transactions;
	if (!connection) throw upstreamError("sui_graphql_unavailable");
	const nodes = (connection.nodes || []).map(mapTransaction).filter(Boolean);
	if (descending) nodes.reverse();

	const pageInfo = connection.pageInfo || {};
	const hasNextPage = descending ? Boolean(pageInfo.hasPreviousPage) : Boolean(pageInfo.hasNextPage);
	const nextCursor = hasNextPage ? (descending ? pageInfo.startCursor : pageInfo.endCursor) || null : null;

	return { data: nodes, nextCursor, hasNextPage };
};

const getCoinMetadata = async (params) => {
	const coinType = String(paramAt(params, 0, "coinType") || "").trim();
	if (!coinType) throw invalidParams("coinType is required");
	const data = await querySuiGraphql(
		`query SuiCoinMeta($coinType: String!) {
			coinMetadata(coinType: $coinType) { address decimals name symbol description iconUrl }
		}`,
		{ coinType }
	);
	const meta = data?.coinMetadata;
	if (!meta) return null;
	return {
		id: meta.address || null,
		decimals: meta.decimals ?? null,
		name: meta.name || "",
		symbol: meta.symbol || "",
		description: meta.description || "",
		iconUrl: meta.iconUrl || null,
	};
};

const referenceGasPrice = async () => {
	const data = await querySuiGraphql(`query { epoch { referenceGasPrice } }`);
	const price = data?.epoch?.referenceGasPrice;
	if (price == null) throw upstreamError("sui_graphql_unavailable");
	return String(price);
};

const getTransactionBlock = async (params) => {
	const digest = String(paramAt(params, 0, "digest") || "").trim();
	if (!digest) throw invalidParams("digest is required");
	const data = await querySuiGraphql(
		`query SuiTx($digest: String!) { transaction(digest: $digest) { ${TX_FIELDS} } }`,
		{ digest }
	);
	if (!data || !Object.prototype.hasOwnProperty.call(data, "transaction")) throw upstreamError("sui_graphql_unavailable");
	return mapTransaction(data.transaction);
};

const HANDLERS = {
	sui_getchainidentifier: chainIdentifier,
	sui_getlatestcheckpointsequencenumber: latestCheckpoint,
	sui_getbalance: getBalance,
	suix_getbalance: getBalance,
	sui_getallbalances: getAllBalances,
	suix_getallbalances: getAllBalances,
	sui_querytransactionblocks: queryTransactionBlocks,
	suix_querytransactionblocks: queryTransactionBlocks,
	sui_getcoinmetadata: getCoinMetadata,
	suix_getcoinmetadata: getCoinMetadata,
	sui_getreferencegasprice: referenceGasPrice,
	suix_getreferencegasprice: referenceGasPrice,
	sui_gettransactionblock: getTransactionBlock,
};

const translateSuiJsonRpc = async (method, params) => {
	const handler = HANDLERS[String(method || "").trim().toLowerCase()];
	if (!handler) throw unavailable(method);
	try {
		return await handler(params);
	} catch (error) {
		if (error?.status) throw error;
		throw upstreamError("sui_graphql_unavailable");
	}
};

module.exports = {
	SUPPORTED_SUI_JSONRPC_METHODS,
	mapTransaction,
	toGraphqlFilter,
	translateSuiJsonRpc,
};
