const { getCleanInstance } = require("../../../Core/axios");
const instance = getCleanInstance(30000);
const { generateRandomUserAgent } = require("../../../Core/helpers");
const oklink = require("./oklink");
const solscan = require("./solscan");
const solanaSourceA = require("./solana-source-a-rpc.module");
const moment = require("moment");
const { getTickerPrice } = require("../../binance/modules/binance.module");

/**
 * oklink raspa el sitio de OKLink con selectores de CSS. Cuando la pagina cambia (o
 * bloquea el raspado) devuelve saldo 0 y sin tokens para billeteras que si tienen
 * fondos, que es lo que reportaron los clientes. En ese caso se lee el nodo.
 */
const looksEmpty = (response) =>
	!response || (!parseFloat(response.balance) && !(response.tokenHoldings?.tokens || []).some((token) => parseFloat(token.amount)));

/**
 * @param {*} params
 */
const getAddress = async (params) => {
	let response;
	let source;

	switch (params.source) {
		case "sourceA":
			try {
				response = await solanaSourceA.getAddress(params);
				source = response ? "sourceA" : null;
			} catch (e) {
				console.error("solana sourceA getAddress:", e?.message || e);
				response = null;
				source = null;
			}
			break;
		case "solscan":
			response = await solscan.getAddress(params);
			source = "solscan";
			break;
		case "oklink":
			response = await oklink.getAddress(params);
			source = "oklink";
			if (looksEmpty(response)) {
				try {
					const saResult = await solanaSourceA.getAddress(params);
					if (!looksEmpty(saResult)) {
						response = saResult;
						source = "sourceA";
					}
				} catch (e) {
					console.error("solana sourceA getAddress:", e?.message || e);
				}
			}
			break;
		default:
			try {
				const saResult = await solanaSourceA.getAddress(params);
				if (!looksEmpty(saResult)) {
					response = saResult;
					source = "sourceA";
					break;
				}
			} catch (e) {
				console.error("solana sourceA getAddress:", e?.message || e);
			}
			const solscanResponse = await solscan.getAddress(params);
			const oklinkResponse = await oklink.getAddress(params);

			response = solscanResponse || oklinkResponse;
			source = solscanResponse ? "solscan" : oklinkResponse ? "oklink" : null;

			if (looksEmpty(response)) {
				try {
					const saResult = await solanaSourceA.getAddress(params);
					if (!looksEmpty(saResult)) {
						response = saResult;
						source = "sourceA";
					}
				} catch (e) {
					console.error("solana sourceA getAddress fallback:", e?.message || e);
				}
			}

			break;
	}

	if (!response) {
		const error = new Error("solana_balance_unavailable");
		error.status = 502;
		throw error;
	}

	// Add source to response if response exists
	if (response) {
		response.source = source;
	}

	return response;
};

/**
 * get transaction status
 * @param {Object} params
 */
const getTokens = async (params, query) => {
	const source = params.source || query?.source;
	if (source === "sourceA") {
		try {
			return await solanaSourceA.getTokens(params, query);
		} catch (e) {
			console.error("solana sourceA getTokens:", e?.message || e);
			return null;
		}
	}
	try {
		return await solanaSourceA.getTokens(params, query);
	} catch (e) {
		console.error("solana sourceA getTokens:", e?.message || e);
	}
	return (await solscan.getTokens(params, query)) || (await oklink.getTokens(params, query));
};

const getTransaction = async (params, query) => {
	try {
		const [txData] = await oklink.getTransaction(params, query);

		const tokens = txData?.innerMainAction?.innerMainAction || [];

		let body = JSON.stringify({
			method: "getTransaction",
			jsonrpc: "2.0",
			params: [
				params.id,
				{
					encoding: "jsonParsed",
					commitment: "confirmed",
					maxSupportedTransactionVersion: 0,
				},
			],
			id: "57cfb101-62b9-4ab0-b33e-0914f9121075",
		});

		const { data } = await instance.post(`https://explorer-api.mainnet-beta.solana.com`, body, {
			headers: {
				origin: "https://explorer.solana.com",
				"Content-Type": "application/json",
			},
		});

		const { price: price } = await getTickerPrice({ symbol: "SOL" });
		const status = data.result?.meta?.status?.Ok === null ? "Success" : "Failed";
		const block = data.result?.slot?.toString();
		const timestamp = data.result?.blockTime.toString();
		const transactionFeeNetwork = data.result?.meta?.fee.toString();
		const date = moment.unix(timestamp);

		return {
			_status: data.result.meta.status,
			age: date.fromNow(),
			amount: txData?.lamports,
			block,
			date: date.format("YYYY-MM-DD HH:mm:ss"),
			fiatAmount: txData?.lamports * price,
			from: txData?.from,
			hash: params.id,
			id: params.id,
			image: txData?.logoUrl,
			network: "solana",
			status,
			symbol: txData?.symbol,
			timestamp,
			to: txData?.to,
			tokensTransferred: formatSolanaTransfers(tokens),
			transactionFee: (transactionFeeNetwork / 1000000000).toString(),
			transactionFeeFiat: ((transactionFeeNetwork / 1000000000) * price).toString(),
			transactionType: tokens.length ? "swap" : "transfer",
		};
	} catch (error) {
		console.error({ error });

		throw new Error("500");
	}
};

const getTransactions = async (params, query) => {
	const source = params.source || query?.source;
	if (source === "sourceA") {
		try {
			return await solanaSourceA.getTransactions(params, query);
		} catch (e) {
			console.error("solana sourceA getTransactions:", e?.message || e);
			return null;
		}
	}
	try {
		return await solanaSourceA.getTransactions(params, query);
	} catch (e) {
		console.error("solana sourceA getTransactions:", e?.message || e);
	}
	return (await solscan.getTransfers(params, query)) || (await oklink.getTransactions(params, query));
};

function formatSolanaTransfers(transfers) {
	return transfers.map((tx) => ({
		amount: tx.value.toString(),
		from: tx.from,
		icon: tx.logoUrl,
		network: "solana",
		symbol: tx.symbol || "SOL",
		to: tx.to,
		token: tx.tokenName || "Wrapped SOL",
	}));
}

const getGasTracker = async () => {
	try {
		const { data } = await instance.get(`${endpoint}/common/sol-market?tokenAddress=So11111111111111111111111111111111111111112`, {
			headers: {
				cookie: "__cf_bm=6Nb_BhzZtOdGxVrRrnJoN83pN6rfOtlvuRxjI90nJ0E-1728040658-1.0.1.1-wWYmBJNnH55RvNIFlxo41XFAhHH4kt68pEvyR2fW2Zb_6hVNARhlKxBPCqoZQ_ZhtRQjCeFp6vReppgZbEYgbw; cf_clearance=ibbR6Iox6IDDq4r5WTmuKO0tkKPcwv8GloL.CCp7V3w-1728040665-1.2.1.1-Ef84Taqzk5aSmCiHV321WYtxUv7EIDJTG0SDgp4J.kjIs6gG9J7GVpSV9HE12tuH7xN5vtzdNt1sm6dOee1c20DQO2Lqd.rymeTv.0g340.1jEjK1BnkO4QUlkmEWdbBHzBOc43akGgAef7InJnNEKcg2eO5dPLXT0waBuDCHTs1VMJWBHhfeAE9jZz4C.pPKJKtUDvCyqvR.KRlokRlHo_gnzTVUQDawAtgdLimOOWAK5huvgGQURDoHngS1E5ne03ScjMqfL9HGKME7wXjsK1M9v6zX0WjGMiRDiXkMX3H8oZieb0wyG.j.UKR7jS3K9ElZYtMaZ2kTH1dRJ2DW13.4Q.H3Q.RZlc7Bv3a9FEKf79.2TUxXaiGtKqFH9IbCrPVxFCQ09YxgSp_U0H0AA; _ga=GA1.1.1401977830.1728040664; _ga_PS3V7B7KV0=GS1.1.1728040664.1.1.1728040689.0.0.0; __cf_bm=Mz6cAvTNjPAeUi30bGhjWOHzNal5QLqwS2T6omWu3c8-1728267695-1.0.1.1-oPl.fRzgy_UIvX86I4hXorbEOT5HKcOEAxcTsfbsYnUgtBpIH.Cck88Gm0KcosZyt6sRto_BNTjyJegI2oYryQ",
				"if-none-match": 'W/"622-Ukdydv8vKaxhKj3QjdlU5A1PS9k"',
				origin: "https://solscan.io",
				priority: "u=1, i",
				referer: "https://solscan.io/",
				"sol-aut": "uommLFJFHe0I=7pB9dls0fKSHLSixPco",
				"user-agent": generateRandomUserAgent(),
			},
		});

		return data.data;
	} catch (error) {
		return null;
	}
};

module.exports = {
	getAddress,
	getTokens,
	getTransaction,
	getTransactions,
	getGasTracker,
};
