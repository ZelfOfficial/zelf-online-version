const moment = require("moment");
const { getAptosClient, normalizeAptosAddress, normalizeTransactionHash, toAptosUpstreamError, withAptosTimeout } = require("./aptos-client");
const { APTOS_DECIMALS, atomicToDecimalString, aptosFeeFromGas, calculateFiatBalance } = require("./aptos-format.util");
const { getAptUsdPrice, getAssetUsdPrice } = require("./aptos-price.util");

const APT_LOGO = "https://assets.coingecko.com/coins/images/26455/standard/aptos_round.png";
const DEFAULT_PAGE_SIZE = 10;
const APTOS_FA_METADATA_ADDRESS = "0x000000000000000000000000000000000000000000000000000000000000000a";

const ACTIVITIES_QUERY = `
	query AptosWalletActivities($address: String!, $limit: Int!, $offset: Int!) {
		fungible_asset_activities(
			where: { owner_address: { _eq: $address }, is_gas_fee: { _eq: false } }
			order_by: [{ transaction_version: desc }, { event_index: desc }]
			limit: $limit
			offset: $offset
		) {
			amount
			asset_type
			block_height
			entry_function_id_str
			event_index
			is_transaction_success
			storage_id
			token_standard
			transaction_timestamp
			transaction_version
			type
		}
	}
`;

const ASSET_METADATA_QUERY = `
	query AptosAssetMetadata($assetTypes: [String!]!) {
		fungible_asset_metadata(where: { asset_type: { _in: $assetTypes } }) {
			asset_type
			decimals
			icon_uri
			name
			symbol
			token_standard
		}
	}
`;

const getPageOptions = (query = {}) => {
    const page = Math.max(Number.parseInt(query.page, 10) || 0, 0);
    const requestedShow = Number.parseInt(query.show, 10) || DEFAULT_PAGE_SIZE;
    const show = Math.min(Math.max(requestedShow, 1), 100);
    return { page, show, offset: page * show };
};

const getTimestampMs = (value) => {
    const raw = String(value || "");
    if (/^\d+$/.test(raw)) return Math.floor(Number(raw) / 1000);
    const parsed = Date.parse(raw.endsWith("Z") ? raw : `${raw}Z`);
    return Number.isFinite(parsed) ? parsed : Date.now();
};

const isNativeApt = (symbol, assetType) => {
    const normalizedAssetType = String(assetType || "").trim().toLowerCase();
    return (
        String(symbol || "").toUpperCase() === "APT" ||
        normalizedAssetType === "0x1::aptos_coin::aptoscoin" ||
        normalizedAssetType === APTOS_FA_METADATA_ADDRESS ||
        normalizedAssetType === "0xa"
    );
};

const buildNativeToken = (amount = "0", aptPrice = "0") => {
    const fiatBalance = calculateFiatBalance(amount, aptPrice);
    return {
        _fiatBalance: String(fiatBalance),
        address_token: "APT",
        amount: String(amount),
        decimals: APTOS_DECIMALS,
        fiatBalance,
        image: APT_LOGO,
        name: "Aptos Coin",
        price: String(aptPrice || "0"),
        symbol: "APT",
        tokenStandard: "v1",
        tokenType: "APT",
    };
};

const mapCoinBalance = (coin, aptPrice) => {
    const metadata = coin?.metadata || {};
    const symbol = metadata.symbol || "TOKEN";
    const nativeApt = isNativeApt(symbol, coin?.asset_type);
    const effectiveSymbol = nativeApt ? "APT" : symbol;
    const decimals = Number.isInteger(metadata.decimals) ? metadata.decimals : nativeApt ? APTOS_DECIMALS : 0;
    const amount = atomicToDecimalString(coin?.amount ?? 0, decimals);
    const price = getAssetUsdPrice(effectiveSymbol, aptPrice);
    const fiatBalance = calculateFiatBalance(amount, price);

    return {
        _fiatBalance: String(fiatBalance),
        address_token: nativeApt ? "APT" : coin?.asset_type || metadata.asset_type || "",
        amount,
        decimals,
        fiatBalance,
        image: metadata.icon_uri || (nativeApt ? APT_LOGO : ""),
        name: metadata.name || (nativeApt ? "Aptos Coin" : symbol),
        price,
        symbol: effectiveSymbol,
        tokenStandard: coin?.token_standard || metadata.token_standard || "",
        tokenType: nativeApt ? "APT" : symbol,
    };
};

const getNativeBalance = async (addressInput) => {
    const address = normalizeAptosAddress(addressInput);
    const aptos = getAptosClient();

    try {
        const result = await withAptosTimeout(
            aptos.view({
                payload: {
                    function: "0x1::coin::balance",
                    functionArguments: [address],
                    typeArguments: ["0x1::aptos_coin::AptosCoin"],
                },
            }),
            "native_balance"
        );
        return atomicToDecimalString(result?.[0] || 0, APTOS_DECIMALS);
    } catch (exception) {
        if (exception?.status === 404) return "0";
        throw toAptosUpstreamError(exception, "aptos_balance_unavailable");
    }
};

const getAssets = async (address, aptPrice) => {
    const aptos = getAptosClient();
    let tokens = [];

    try {
        const coins = await withAptosTimeout(aptos.getAccountCoinsData({ accountAddress: address, options: { limit: 100 } }), "assets");
        tokens = (coins || []).map((coin) => mapCoinBalance(coin, aptPrice));
    } catch (exception) {
        console.error("Aptos indexer assets unavailable:", exception.status || exception.code || "unknown");
        const nativeBalance = await getNativeBalance(address);
        tokens = [buildNativeToken(nativeBalance, aptPrice)];
    }

    const nativeTokens = tokens.filter((token) => token.symbol === "APT");
    const nonNativeTokens = tokens.filter((token) => token.symbol !== "APT");
    let primaryNative = nativeTokens.find((token) => Number(token.amount || 0) > 0) || nativeTokens[0] || null;

    if (!primaryNative || Number(primaryNative.amount || 0) === 0) {
        try {
            const onChainBalance = await getNativeBalance(address);
            if (Number(onChainBalance || 0) > 0) {
                primaryNative = buildNativeToken(onChainBalance, aptPrice);
            }
        } catch (_error) {
            /* Keep indexer result when fullnode view is unavailable */
        }
    }

    return [primaryNative || buildNativeToken("0", aptPrice), ...nonNativeTokens];
};

const readAddressArgument = (value) => {
    const candidate = typeof value === "string" ? value : value?.inner;
    if (!candidate) return null;
    try {
        return normalizeAptosAddress(candidate);
    } catch (_error) {
        return null;
    }
};

const extractRecipient = (transaction) => {
    const args = transaction?.payload?.arguments;
    if (!Array.isArray(args)) return "";

    for (const value of args) {
        const candidate = readAddressArgument(value);
        if (candidate) return candidate;
    }

    return "";
};

const normalizeOptionalAddress = (value) => {
    if (!value) return "";
    try {
        return normalizeAptosAddress(value);
    } catch (_error) {
        return String(value);
    }
};

const mapTransaction = (transaction, activity, walletAddress, aptPrice = "0") => {
    const timestamp = getTimestampMs(activity?.transaction_timestamp || transaction?.timestamp);
    const metadata = activity?.metadata || {};
    const decimals = Number.isInteger(metadata.decimals) ? metadata.decimals : APTOS_DECIMALS;
    const payloadFunction = String(transaction?.payload?.function || "");
    const payloadArguments = Array.isArray(transaction?.payload?.arguments) ? transaction.payload.arguments : [];
    const isNativeTransfer = !activity && /::aptos_account::transfer(_coins)?$/.test(payloadFunction);
    const payloadAmount = isNativeTransfer ? payloadArguments[1] : null;
    const amount = activity
        ? atomicToDecimalString(activity.amount ?? 0, decimals)
        : payloadAmount != null
        ? atomicToDecimalString(payloadAmount, APTOS_DECIMALS)
        : null;
    const symbol = metadata.symbol || (isNativeTransfer ? "APT" : activity ? "TOKEN" : null);
    const price = getAssetUsdPrice(symbol, aptPrice);
    const traffic = String(activity?.type || "").includes("Withdraw") ? "OUT" : activity ? "IN" : walletAddress ? "OUT" : null;
    const normalizedWallet = walletAddress ? normalizeOptionalAddress(walletAddress) : "";
    const sender = normalizeOptionalAddress(transaction?.sender);
    const recipient = extractRecipient(transaction);
    const from = traffic === "OUT" ? normalizedWallet : sender;
    const to = traffic === "OUT" ? recipient : traffic === "IN" ? normalizedWallet : recipient;
    const gas = aptosFeeFromGas(transaction?.gas_used || 0, transaction?.gas_unit_price || 0);
    const method = activity?.entry_function_id_str || payloadFunction || transaction?.type || "unknown";
    const success = activity ? activity.is_transaction_success : transaction?.success;

    return {
        _amount: amount,
        _source: activity || transaction,
        age: moment(timestamp).fromNow(),
        amount,
        asset: symbol,
        assetType: activity?.asset_type || null,
        block: String(activity?.transaction_version || transaction?.version || "0"),
        date: moment(timestamp).format("YYYY-MM-DD HH:mm:ss"),
        fiatBalance: amount == null ? 0 : calculateFiatBalance(amount, price),
        from,
        gas: gas.feeApt,
        hash: transaction?.hash || "",
        method: String(method).split("::").pop(),
        price,
        status: transaction?.type === "pending_transaction" ? "pending" : success === false ? "failed" : "success",
        timestamp,
        to,
        traffic,
        txnFee: gas.feeApt,
    };
};

const fetchActivities = async (address, pageOptions) => {
	const aptos = getAptosClient();
    const result = await withAptosTimeout(
        aptos.queryIndexer({
            query: {
                query: ACTIVITIES_QUERY,
                variables: {
                    address,
                    limit: pageOptions.show,
                    offset: pageOptions.offset,
                },
            },
        }),
        "transactions"
    );

	const activities = result?.fungible_asset_activities || [];
	const assetTypes = [...new Set(activities.map((activity) => activity.asset_type).filter(Boolean))];
	const metadataByType = new Map();

	if (assetTypes.length) {
		try {
			const metadataResult = await withAptosTimeout(
				aptos.queryIndexer({
					query: {
						query: ASSET_METADATA_QUERY,
						variables: { assetTypes },
					},
				}),
				"asset_metadata",
			);

			for (const metadata of metadataResult?.fungible_asset_metadata || []) {
				metadataByType.set(metadata.asset_type, metadata);
			}
		} catch (exception) {
			console.error("Aptos activity metadata unavailable:", exception.status || exception.code || "unknown");
		}
	}

	return activities.map((activity) => ({
		...activity,
		metadata:
			metadataByType.get(activity.asset_type) ||
			(activity.asset_type === APTOS_FA_METADATA_ADDRESS
				? { asset_type: APTOS_FA_METADATA_ADDRESS, decimals: APTOS_DECIMALS, name: "Aptos Coin", symbol: "APT", token_standard: "v2" }
				: null),
	}));
};

const getTransactions = async (params, query = {}) => {
    const address = normalizeAptosAddress(params.id);
    const pageOptions = getPageOptions(query);
    const aptos = getAptosClient();
    const aptPrice = await getAptUsdPrice();

    try {
        const activities = await fetchActivities(address, pageOptions);
        const versions = [...new Set(activities.map((activity) => String(activity.transaction_version)))];
        const transactionsByVersion = new Map();

        await Promise.all(
            versions.map(async (version) => {
                try {
                    const transaction = await withAptosTimeout(aptos.getTransactionByVersion({ ledgerVersion: version }), "transaction_detail");
                    transactionsByVersion.set(version, transaction);
                } catch (error) {
                    console.error(`Aptos transaction version ${version}:`, error.message);
                }
            })
        );

        const transactions = activities.map((activity) =>
            mapTransaction(transactionsByVersion.get(String(activity.transaction_version)), activity, address, aptPrice)
        );

        return {
            pagination: {
                page: String(pageOptions.page),
                records: String(transactions.length),
                show: String(pageOptions.show),
            },
            transactions,
        };
    } catch (indexerException) {
        console.error("Aptos indexer transactions unavailable:", indexerException.status || indexerException.code || "unknown");

        try {
            const fallbackLimit = Math.min((pageOptions.page + 1) * pageOptions.show, 100);
            const accountTransactions = await withAptosTimeout(
                aptos.getAccountTransactions({
                    accountAddress: address,
                    options: { limit: fallbackLimit },
                }),
                "account_transactions"
            );
            const transactions = [...accountTransactions]
                .reverse()
                .slice(pageOptions.offset, pageOptions.offset + pageOptions.show)
                .map((transaction) => mapTransaction(transaction, null, address, aptPrice));

            return {
                partial: true,
                pagination: {
                    page: String(pageOptions.page),
                    records: String(transactions.length),
                    show: String(pageOptions.show),
                },
                source: "fullnode",
                transactions,
            };
        } catch (fullnodeException) {
            throw toAptosUpstreamError(fullnodeException, "aptos_transactions_unavailable");
        }
    }
};

const getAddress = async (params) => {
    const address = normalizeAptosAddress(params.id);
    let aptPrice = "0";

    try {
        aptPrice = await getAptUsdPrice();
    } catch (_error) {
        /* Fiat price is optional; on-chain data remains available. */
    }

    const [tokens, transactionsResult] = await Promise.all([
        getAssets(address, aptPrice),
        getTransactions({ id: address }, { page: "0", show: String(DEFAULT_PAGE_SIZE) }).catch((error) => {
            console.error("Aptos dashboard transactions:", error.message);
            return { transactions: [] };
        }),
    ]);

    const nativeToken = tokens.find((token) => token.symbol === "APT") || buildNativeToken("0", aptPrice);
    const fiatBalance = parseFloat(tokens.reduce((sum, token) => sum + Number(token.fiatBalance || 0), 0).toFixed(4));

    return {
        _balance: nativeToken.amount,
        _fiatBalance: String(fiatBalance),
        account: {
            asset: "APT",
            fiatBalance: nativeToken.fiatBalance,
            price: String(aptPrice),
        },
        address,
        balance: nativeToken.amount,
        fiatBalance,
        network: "aptos",
        tokenHoldings: {
            balance: String(fiatBalance),
            total: tokens.length,
            tokens,
        },
        transactions: transactionsResult.transactions || [],
        transactionsPartial: Boolean(transactionsResult.partial),
        transactionsSource: transactionsResult.source || "indexer",
    };
};

const getTokens = async (params, query = {}) => {
    const address = normalizeAptosAddress(params.id);
    const pageOptions = getPageOptions(query);
    const aptPrice = await getAptUsdPrice();
    const tokens = await getAssets(address, aptPrice);
    const slice = tokens.slice(pageOptions.offset, pageOptions.offset + pageOptions.show);
    const fiatBalance = tokens.reduce((sum, token) => sum + Number(token.fiatBalance || 0), 0);

    return {
        balance: String(fiatBalance),
        total: tokens.length,
        tokens: slice,
    };
};

const getTransaction = async (params) => {
    const hash = normalizeTransactionHash(params.id);
    const aptos = getAptosClient();

    try {
        const transaction = await withAptosTimeout(aptos.getTransactionByHash({ transactionHash: hash }), "transaction_detail");
        return mapTransaction(transaction, null, null, "0");
    } catch (exception) {
        if (exception?.status === 404) {
            const error = new Error("aptos_transaction_not_found");
            error.status = 404;
            throw error;
        }
        throw toAptosUpstreamError(exception, "aptos_transaction_unavailable");
    }
};

module.exports = {
	ACTIVITIES_QUERY,
	ASSET_METADATA_QUERY,
    APT_LOGO,
    buildNativeToken,
    getAddress,
    getNativeBalance,
    getTokens,
    getTransaction,
    getTransactions,
    mapCoinBalance,
    mapTransaction,
};
