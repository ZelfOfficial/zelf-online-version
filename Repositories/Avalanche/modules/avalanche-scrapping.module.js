const axios = require("axios");
const moment = require("moment");
const { generateRandomUserAgent } = require("../../../Core/helpers");
const { get_ApiKey } = require("../../Solana/modules/oklink");
const cheerio = require("cheerio");
// Crear instancia axios con timeout
const instance = axios.create({ timeout: 30000 });

// Crear instancia https que ignora certificados SSL inv?lidos
const https = require("https");

const agent = new https.Agent({ rejectUnauthorized: false });

/**
 * Obtiene el balance de una direcci?n en Avalanche
 * @param {Object} params - Contiene el id (direcci?n)
 */
const config = require("../../../Core/config");
const { formatEther } = require("ethers");
const { getTickerPrice } = require("../../binance/modules/binance.module");
const { mapRouteScanHolding } = require("./avalanche-balance.util");
const {
	upstreamUnavailableError,
	normalizeTransactionLimit,
	mapOkLinkTransaction,
	mapRouteScanTransaction,
	mapGlacierTransaction,
	isOkLinkSuccess,
	sortTransactions,
} = require("./avalanche-transaction.util");

const nativeBalance = async (address) => {
    const endpoints = [...new Set([config.rpc?.chains?.avalanche?.rpcUrl, config.avalanche?.rpcUrl,
        "https://api.avax.network/ext/bc/C/rpc"].filter(Boolean))];
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
        getTokens(params, { show: "200" })
            .then((value) => ({ ok: true, value }))
            .catch((error) => {
                console.warn("Avalanche token holdings unavailable:", error?.message || error);
                return { ok: false, error };
            }),
        getTransactionsList({ id: params.id, page: "0", show: "100" })
            .then((transactions) => ({ ok: true, value: { transactions, incomplete: false } }))
            .catch((error) => {
                console.warn("Avalanche transactions unavailable:", error?.message || error);
                return { ok: false, error };
            }),
    ]);

    const tokenHoldings = tokenHoldingsResult.ok
        ? tokenHoldingsResult.value
        : { balance: "0", total: 0, tokens: [] };
    const history = historyResult.ok ? historyResult.value : { transactions: [], incomplete: true };
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
            ? { tokensError: tokenHoldingsResult.error?.message || "avalanche_tokens_unavailable" }
            : {}),
        ...(transactionsFailed
            ? { transactionsError: historyResult.error?.message || "avalanche_transactions_unavailable" }
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

const getTokens = async (params, query) => {
    try { return await getTokensFromGlacier(params, query); }
    catch { return getTokensFromRouteScan(params.id); }
};

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

const getTransactionsListFromOkLink = async (params, limit) => {
	const t = Date.now();
	const { id, page } = params;

	const url = `https://www.oklink.com/api/explorer/v2/avaxc/addresses/${id}/transactionsByClassfy/condition?offset=${page || "0"}&limit=${limit}&address=${id}&nonzeroValue=false&t=${t}`;

	const { data } = await axios.get(url, {
		timeout: 8000,
		httpsAgent: agent,
		headers: {
			"X-Apikey": get_ApiKey().getApiKey(),
			"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
		},
	});

	if (!isOkLinkSuccess(data)) {
		throw new Error(`oklink_transactions_unavailable_${data?.code || "invalid"}`);
	}

	return sortTransactions(data.data.hits.map((tx) => mapOkLinkTransaction(tx, id)));
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
 * Obtiene las transacciones de una direcci?n
 * @param {Object} params - Contiene el id (direcci?n)
 * @param {Object} query - Par?metros de paginaci?n
 */
const getTransactionsList = async (params) => {
	const limit = normalizeTransactionLimit(params.show);
	const queryParams = { ...params, show: String(limit) };

	try {
		return await getTransactionsListFromOkLink(queryParams, limit);
	} catch (oklinkErr) {
		console.warn("Avalanche OKLink transactions failed:", oklinkErr?.message || oklinkErr);

		try {
			return await getTransactionsListFromRouteScan(queryParams, limit);
		} catch (routeScanErr) {
			console.warn("Avalanche RouteScan transactions failed:", routeScanErr?.message || routeScanErr);

			try {
				return await getTransactionsListFromGlacier(queryParams, limit);
			} catch (glacierErr) {
				console.error("Avalanche Glacier transactions failed:", glacierErr?.message || glacierErr);
				throw upstreamUnavailableError("avalanche_transactions_unavailable");
			}
		}
	}
};

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
