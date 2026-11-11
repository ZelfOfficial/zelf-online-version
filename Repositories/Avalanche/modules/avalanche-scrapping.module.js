const axios = require("axios");
const moment = require("moment");
const { generateRandomUserAgent } = require("../../../Core/helpers");
const cheerio = require("cheerio");
// Crear instancia axios con timeout
const instance = axios.create({ timeout: 30000 });

const ROUTESCAN_ETHERSCAN_API = "https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api";

/**
 * Obtiene el balance de una direcci?n en Avalanche
 * @param {Object} params - Contiene el id (direcci?n)
 */
const config = require("../../../Core/config");
const { formatEther } = require("ethers");
const { getTickerPrice } = require("../../binance/modules/binance.module");
const { mapRouteScanHolding, mapRoutescanAddressToken } = require("./avalanche-balance.util");
const {
	normalizeTransactionLimit,
	mapEtherscanAccountTransaction,
	mapRouteScanTransaction,
	mapGlacierTransaction,
	sortTransactions,
} = require("./avalanche-transaction.util");

const providerFailureText = (error) => {
	const status = error?.response?.status;
	const data = error?.response?.data;
	const detail = typeof data === "string" ? data : data?.message || data?.result || data?.msg;
	return String([status, detail, error?.message].filter((part) => part !== undefined && part !== null && part !== "").join(" "))
		.replace(/apikey=[^&\s]+/gi, "apikey=redacted")
		.slice(0, 300);
};

const routescanPageNumber = (page) => {
	const parsed = parseInt(String(page ?? "0"), 10);
	if (!Number.isFinite(parsed) || parsed < 0) return 1;
	return parsed + 1;
};

const emptyTokenHoldings = () => ({ balance: "0", total: 0, tokens: [] });

const avalancheRpcEndpoints = () =>
	[...new Set([config.rpc?.chains?.avalanche?.rpcUrl, config.avalanche?.rpcUrl, "https://api.avax.network/ext/bc/C/rpc"].filter(Boolean))];

const routescanAccount = async (params) => {
	const response = await instance.get(ROUTESCAN_ETHERSCAN_API, {
		params: { module: "account", ...params },
		timeout: 8000,
		validateStatus: (status) => status < 500,
	});
	if (response.status >= 400) {
		const error = new Error(`routescan_http_${response.status}`);
		error.response = { status: response.status, data: response.data };
		throw error;
	}
	return response.data;
};

const isEtherscanEmpty = (data) => {
	const result = data?.result;
	if (Array.isArray(result) && result.length === 0) return true;
	const text = `${typeof result === "string" ? result : ""} ${data?.message || ""}`;
	return /no (transactions|records|tokens)/i.test(text);
};

const etherscanRows = (data, invalidCode) => {
	if (String(data?.status) === "1" && Array.isArray(data?.result)) return data.result;
	if (isEtherscanEmpty(data)) return [];
	const detail = typeof data?.result === "string" ? data.result : data?.message || invalidCode;
	throw new Error(String(detail).slice(0, 180));
};

const holdingsFromTokens = (tokens) => ({
	balance: String(tokens.reduce((sum, token) => sum + Number(token.fiatBalance || 0), 0)),
	total: tokens.length,
	tokens,
});

const nativeBalance = async (address) => {
    const endpoints = avalancheRpcEndpoints();
    for (const endpoint of endpoints) {
        try {
            const { data } = await axios.post(endpoint,
                { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }, { timeout: 8000 });
            if (data.error || !/^0x[0-9a-f]+$/i.test(data.result || "")) throw new Error("invalid_rpc_balance");
            return formatEther(BigInt(data.result));
        } catch { /* Try the independent public C-chain node. */ }
    }
    const error = new Error("avalanche_balance_unavailable"); error.status = 502; throw error;
};

const getBalance = async (params) => {
    const [quote, balance, tokenHoldingsResult, historyResult] = await Promise.all([
        getTickerPrice({ symbol: "AVAX" }).catch(() => ({ price: "0" })),
        nativeBalance(params.id),
        loadTokens(params, { show: "200" }),
        loadTransactions({ id: params.id, page: "0", show: "100" }),
    ]);

    const tokenHoldings = tokenHoldingsResult.value;
    const history = { transactions: historyResult.value, incomplete: !historyResult.ok };
    const tokensFailed = !tokenHoldingsResult.ok;
    const transactionsFailed = !historyResult.ok;
    const partial = tokensFailed || transactionsFailed;

    const price = String(quote.price);
    const fiatBalance = Number(balance) * Number(price);
    tokenHoldings.tokens.unshift({
        amount: balance,
        decimals: 18,
        fiatBalance,
        image: "https://cdn.zelf.world/icons/ic_avax.png",
        name: "Avalanche",
        price,
        symbol: "AVAX",
        tokenType: "AVAX",
    });
    return {
        _balance: Number(balance),
        address: params.id,
        balance,
        decimals: 18,
        fiatBalance,
        account: { asset: "AVAX", fiatBalance: String(fiatBalance), price },
        tokenHoldings,
        transactions: history.transactions,
        transactionsIncomplete: history.incomplete || transactionsFailed,
        partial,
        tokensFailed,
        transactionsFailed,
        ...(tokensFailed
            ? { tokensError: tokenHoldingsResult.error || "avalanche_tokens_unavailable" }
            : {}),
        ...(transactionsFailed
            ? { transactionsError: historyResult.error || "avalanche_transactions_unavailable" }
            : {}),
    };
};

const getTokensFromRouteScan = async (address) => {
    const tokens = [];
    let next;
    for (let page = 0; page < 20; page++) {
        const { data } = await instance.get(`https://api.routescan.io/v2/network/mainnet/evm/43114/address/${address}/erc20-holdings`,
            { params: { limit: 100, ...(next ? { next } : {}) }, timeout: 8000 });
        if (!Array.isArray(data.items)) throw new Error("invalid_avalanche_holdings");
        tokens.push(...data.items.map(mapRouteScanHolding).filter(Boolean));
        next = data.link?.nextToken;
        if (!next) return { balance: String(tokens.reduce((sum, token) => sum + token.fiatBalance, 0)), total: tokens.length, tokens };
    }
    throw new Error("avalanche_holdings_pagination_incomplete");
};

const getTokensFromRoutescanHoldings = async (address, query = {}) => {
	const data = await routescanAccount({
		action: "addresstokenbalance",
		address,
		page: routescanPageNumber(query.page),
		offset: normalizeTransactionLimit(query.show, 100),
	});
	return holdingsFromTokens(etherscanRows(data, "routescan_token_list_invalid").map(mapRoutescanAddressToken).filter(Boolean));
};

const tokenQuantityFromBalancePayload = (data) => {
	const result = data?.result;
	return typeof result === "string" && /^\d+$/.test(result) ? result : null;
};

const tokenBalanceViaRpc = async (contractAddress, walletAddress) => {
	const data = `0x70a08231${String(walletAddress).toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
	for (const endpoint of avalancheRpcEndpoints()) {
		try {
			const { data: body } = await axios.post(
				endpoint,
				{ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: contractAddress, data }, "latest"] },
				{ timeout: 8000 }
			);
			const hex = body?.result;
			if (typeof hex === "string" && /^0x[0-9a-f]+$/i.test(hex)) return BigInt(hex).toString();
		} catch {
			/* Try the next configured Avalanche RPC. */
		}
	}
	return null;
};

const getTokensFromRoutescanTransfers = async (address, query = {}) => {
	const data = await routescanAccount({
		action: "tokentx",
		address,
		page: routescanPageNumber(query.page),
		offset: normalizeTransactionLimit(query.show, 100),
		startblock: 0,
		endblock: 99999999,
		sort: "desc",
	});
	const unique = [];
	const seen = new Set();
	for (const row of etherscanRows(data, "routescan_tokentx_invalid")) {
		const key = String(row?.contractAddress || "").toLowerCase();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		unique.push(row);
		if (unique.length >= 20) break;
	}

	const tokens = [];
	for (const row of unique) {
		let quantity = null;
		try {
			quantity = tokenQuantityFromBalancePayload(
				await routescanAccount({
					action: "tokenbalance",
					contractaddress: row.contractAddress,
					address,
					tag: "latest",
				})
			);
		} catch (error) {
			console.warn("Avalanche Routescan tokenbalance failed:", providerFailureText(error));
		}
		if (!quantity) quantity = await tokenBalanceViaRpc(row.contractAddress, address);
		if (!quantity || quantity === "0") continue;
		const mapped = mapRoutescanAddressToken({
			TokenAddress: row.contractAddress,
			TokenName: row.tokenName,
			TokenSymbol: row.tokenSymbol,
			TokenQuantity: quantity,
			TokenDivisor: row.tokenDecimal,
		});
		if (mapped) tokens.push(mapped);
	}
	return holdingsFromTokens(tokens);
};

const loadTokens = async (params, query = {}) => {
	try {
		return { ok: true, value: await getTokensFromRoutescanHoldings(params.id, query) };
	} catch (error) {
		console.warn("Avalanche Routescan token list failed:", providerFailureText(error));
	}

	try {
		const fromTransfers = await getTokensFromRoutescanTransfers(params.id, query);
		if (fromTransfers.tokens.length) return { ok: true, value: fromTransfers };
	} catch (error) {
		console.warn("Avalanche Routescan token transfers failed:", providerFailureText(error));
	}

	try {
		return { ok: true, value: await getTokensFromGlacier(params, query) };
	} catch (error) {
		console.warn("Avalanche Glacier token list failed:", providerFailureText(error));
	}

	try {
		return { ok: true, value: await getTokensFromRouteScan(params.id) };
	} catch (error) {
		console.warn("Avalanche RouteScan holdings failed:", providerFailureText(error));
	}

	return { ok: false, error: "avalanche_tokens_unavailable", value: emptyTokenHoldings() };
};

const getTokens = async (params, query) => (await loadTokens(params, query)).value;

/**
 * Obtiene los tokens ERC20 de una direcci?n
 * @param {Object} params - Contiene el id (direcci?n)
 * @param {Object} query - Par?metros adicionales
 */
const getTokensFromGlacier = async (params, query) => {
	// Obtener tokens ERC20
	let data;
	try {
		const response = await instance.get(
			`https://glacier-api.avax.network/v1/chains/43114/addresses/${params.id}/balances:listErc20?pageSize=100&filterSpamTokens=true`,
			{ headers: { "user-agent": generateRandomUserAgent() }, timeout: 8000 },
		);
		data = response.data;
	} catch (error) {
		const status = error?.response?.status;
		throw new Error(status ? `glacier_holdings_${status}` : "glacier_holdings_unavailable");
	}

	// Obtener conteo total de tokens (RouteScan is optional - fall back to Glacier count if unavailable)
	let erc20Count = data.erc20TokenBalances.length;
	let erc721Count = 0;
	let erc1155Count = 0;

	try {
		const total = await instance.get(`https://cdn.routescan.io/api/blockchain/all/address/${params.id}?ecosystem=avalanche`, {
			headers: { "user-agent": generateRandomUserAgent() },
			timeout: 5000,
		});

		erc20Count = total.data.erc20Count ?? erc20Count;
		erc721Count = total.data.erc721Count ?? 0;
		erc1155Count = total.data.erc1155Count ?? 0;
	} catch (routeScanError) {
		console.warn("RouteScan unavailable, falling back to Glacier token counts:", routeScanError?.message);
	}

	// Formatear datos de tokens
	const formattedTokens = data.erc20TokenBalances.map((token) => ({
		_amount: parseFloat((Number(token.balance) / 10 ** token.decimals).toFixed(12)),
		_fiatBalance: token.balanceValue?.value.toString(),
		_price: token.price?.value,
		address: token.address,
		amount: (Number(token.balance) / 10 ** token.decimals).toFixed(12),
		decimals: token.decimals,
		fiatBalance: token.balanceValue?.value || 0,
		image: token.logoUri,
		name: token.name,
		price: token.price?.value?.toString() || "0",
		symbol: token.symbol,
		tokenType: token.ercType,
	}));

	// Calcular balance total en moneda fiat
	const totalFiatBalance = formattedTokens.reduce((sum, token) => sum + parseFloat(token.fiatBalance), 0);

	return {
		balance: totalFiatBalance.toString(),
		total: erc20Count + erc721Count + erc1155Count,
		tokens: formattedTokens,
	};
};

const getTransactionsListFromRoutescanEtherscan = async (params, limit) => {
	const data = await routescanAccount({
		action: "txlist",
		address: params.id,
		startblock: 0,
		endblock: 99999999,
		page: routescanPageNumber(params.page),
		offset: limit,
		sort: "desc",
	});
	return sortTransactions(etherscanRows(data, "routescan_txlist_invalid").map((tx) => mapEtherscanAccountTransaction(tx, params.id)));
};

const getTransactionsListFromRouteScan = async (params, limit) => {
	const { id } = params;
	const { data } = await instance.get(
		`https://api.routescan.io/v2/network/mainnet/evm/43114/address/${id}/transactions`,
		{ params: { limit }, timeout: 8000 }
	);

	if (!Array.isArray(data?.items)) {
		throw new Error("invalid_routescan_transactions");
	}

	return sortTransactions(data.items.map((tx) => mapRouteScanTransaction(tx, id)));
};

const getTransactionsListFromGlacier = async (params, limit) => {
	const { id } = params;
	const { data } = await instance.get(
		`https://glacier-api.avax.network/v1/chains/43114/addresses/${id}/transactions`,
		{
			params: { pageSize: limit },
			headers: { "user-agent": generateRandomUserAgent() },
			timeout: 8000,
		}
	);

	if (!Array.isArray(data?.transactions)) {
		throw new Error("invalid_glacier_transactions");
	}

	return sortTransactions(data.transactions.map((tx) => mapGlacierTransaction(tx, id)));
};

/**
 * Historial nativo de C-Chain. Routescan (API compatible con Etherscan) es la fuente.
 * Si el proveedor falla, se usa el listado de RouteScan y luego Glacier. Un fallo total
 * devuelve [] para que la extensión no reciba 500.
 */
const loadTransactions = async (params) => {
	const limit = normalizeTransactionLimit(params.show);
	const queryParams = { ...params, show: String(limit) };

	try {
		return { ok: true, value: await getTransactionsListFromRoutescanEtherscan(queryParams, limit) };
	} catch (error) {
		console.warn("Avalanche Routescan transactions failed:", providerFailureText(error));
	}

	try {
		return { ok: true, value: await getTransactionsListFromRouteScan(queryParams, limit) };
	} catch (error) {
		console.warn("Avalanche RouteScan transactions failed:", providerFailureText(error));
	}

	try {
		return { ok: true, value: await getTransactionsListFromGlacier(queryParams, limit) };
	} catch (error) {
		console.warn("Avalanche Glacier transactions failed:", providerFailureText(error));
	}

	return { ok: false, error: "avalanche_transactions_unavailable", value: [] };
};

const getTransactionsList = async (params) => (await loadTransactions(params)).value;

/**
 * Obtiene detalles de una transacci?n espec?fica
 * @param {Object} params - Contiene el id (hash de la transacci?n)
 */
const getTransactionDetail = async (params) => {
	try {
		const id = params.id;

		const baseUrl = "https://snowscan.xyz";

		const { data } = await instance.get(`${baseUrl}/tx/${id}`, {
			headers: {
				"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
				"Upgrade-Insecure-Requests": "1",
			},
		});

		const $ = cheerio.load(data);
		let tokensTransferred = [];
		const transactionType = $("#wrapperContent > div > div > span:nth-child(1)").text() || "Swap";

		try {
			const transactionDetailsHtml = $("#nav_tabcontent_erc20_transfer").html();

			const $$ = cheerio.load(transactionDetailsHtml);

			$$(".row-count").each((i, elem) => {
				const $elem = $$(elem);
				const from = $elem.find('span.fw-medium:contains("From")').next("a").attr("data-highlight-target");
				const to = $elem.find('span.fw-medium:contains("To")').next("a").attr("data-highlight-target");
				const amount = $elem.find('span.fw-medium:contains("For")').next("span").text();
				const tokenElement = $elem.find('a[href*="/token/"]').last();
				const tokenName = tokenElement.find('span[data-bs-toggle="tooltip"]').first().text().trim();

				const symbol = tokenElement.find("span > span.text-muted > span").first().text().trim();

				const icon = tokenElement.find("img").attr("src");

				tokensTransferred.push({
					from,
					to,
					amount,
					symbol,
					network: "avalanche",
					token: tokenName,
					icon: icon ? `https://snowscan.xyz${icon}` : null,
				});
			});
		} catch (error) {}

		const status = $("#ContentPlaceHolder1_maintable > div.card.p-5 > div:nth-child(2) span.badge").text().split(" ")[0].trim();

		const block = $(
			"#ContentPlaceHolder1_maintable > div.card.p-5 > div:nth-child(3) > div.col-md-9 > div > span.d-flex.align-items-center.gap-1 > a"
		).text();

		const timestamp2 = $("#ContentPlaceHolder1_divTimeStamp > div > div.col-md-9").text().trim().replace(/\n/g, "").split("|")[0].split(" (")[0];

		const timestamp = $("#ContentPlaceHolder1_divTimeStamp > div > div.col-md-9").text().trim().split("|")[0];

		const date = $("#ContentPlaceHolder1_divTimeStamp > div > div.col-md-9")
			.text()
			.trim()
			.replace(/\n/g, "")
			.split("|")[0]
			.split(" (")[1]
			.replace(" AM UTC)", "")
			.replace(" PM UTC)", "");

		const from_a = $("#ContentPlaceHolder1_maintable div.from-address-col").html();

		const from_div = cheerio.load(from_a);

		const from = from_div("a.js-clipboard").attr("data-clipboard-text");
		///en pruba 9
		const to_a = $("#ContentPlaceHolder1_maintable div.to-address-col").html();

		const to_div = cheerio.load(to_a);

		const to = to_div("a.js-clipboard").attr("data-clipboard-text");

		// Wallet-centric order: first row = first ERC-20 out from tx initiator, last row = last ERC-20 in to same.
		// Helps LiFi-style multi-hop where DOM order ends on an intermediate (e.g. USDt) instead of final receive.
		const normAddr = (a) => (a && String(a).toLowerCase().trim()) || "";
		const user = normAddr(from);

		if (user && tokensTransferred.length >= 2 && /swap|call/i.test(String(transactionType))) {
			let idxFirstOut = -1;
			let idxLastIn = -1;

			tokensTransferred.forEach((t, i) => {
				if (idxFirstOut < 0 && normAddr(t.from) === user) {
					idxFirstOut = i;
				}
			});

			for (let i = tokensTransferred.length - 1; i >= 0; i--) {
				if (normAddr(tokensTransferred[i].to) === user) {
					idxLastIn = i;
					break;
				}
			}

			if (idxFirstOut >= 0 && idxLastIn >= 0 && idxFirstOut !== idxLastIn) {
				const rowOut = tokensTransferred[idxFirstOut];
				const rowIn = tokensTransferred[idxLastIn];
				const middle = tokensTransferred.filter((_, i) => i !== idxFirstOut && i !== idxLastIn);

				tokensTransferred = [rowOut, ...middle, rowIn];
			}
		}

		const valueNetwork = $("#ContentPlaceHolder1_spanValue > div > ")
			.text()
			.replace("AVAX", "")
			.split("$")[0]
			.trim()
			.replace("(", "")
			.replace(")", "")
			.trim();

		const valueDolar =
			$("#ContentPlaceHolder1_spanValue > div > span.text-muted").text().trim().replace("($", "").replace(")", "") ||
			$("#ContentPlaceHolder1_spanValue > div > ").text().replace("AVAX", "").split("$")[1].trim();

		const transactionFee = $("#ContentPlaceHolder1_spanTxFee > div > span:nth-child(1)").text().replace("AVAX", "").trim();

		const transactionFeeFiat = $("#data-tfprice").text().replace("$", "").replace(")", "").replace("(", "").trim();

		const gasPriceGwei = $("#ContentPlaceHolder1_spanGasPrice").text().split("Gwei");

		const gasPrice = gasPriceGwei[0].trim();
		const gwei = gasPriceGwei[1].replace("(", "").replace(")", "").replace("AVAX", "").trim();

		const observation = $("#ContentPlaceHolder1_spanValue > div > span:nth-child(4) > span").text().replace("[", "").replace("]", "").trim();

		const response = {
			age: timestamp2,
			amount: Number(valueNetwork),
			block,
			date: moment(date, "MMM-DD-YYYY HH:mm:ss").format("YYYY-MM-DD HH:mm:ss"),
			fiatAmount: Number(valueDolar),
			from,
			gasPrice,
			gwei,
			hash: id,
			id,
			image: "https://snowscan.xyz/assets/avax/images/svg/logos/chain-dim.svg",
			network: "avalanche",
			observation,
			status,
			symbol: "AVAX",
			timestamp,
			to,
			tokensTransferred,
			transactionFee,
			transactionFeeFiat,
			transactionType,
		};

		if (!id || !status || !to || !from) {
			throw new Error("404:transaction_not_found");
		}

		return response;
	} catch (exception) {
		const error = new Error("transaction_not_found");

		error.status = 404;

		throw error;
	}
};

module.exports = {
	getBalance,
	getTransactionsList,
	getTransactionDetail,
	getTokens,
};
