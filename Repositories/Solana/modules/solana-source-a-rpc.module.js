const { getCleanInstance } = require("../../../Core/axios");
const { generateRandomUserAgent } = require("../../../Core/helpers");
const {
	getNaasNodeUrl,
	NAAS_CHAIN,
	refreshNaasCatalogAfterUnauthorized,
	isNaasNodeUnauthorizedError,
} = require("../../../Core/naas-gateway-catalog");
const config = require("../../../Core/config");
const moment = require("moment");
const { getTickerPrice } = require("../../binance/modules/binance.module");
const { getKnownSplDisplay, WSOL_MINT } = require("./solana-spl-known-metadata");
const { enrichSplTokenRowsWithJupiter } = require("./jupiter-spl-metadata.module");
const { summarizeParsedTransaction } = require("./solana-tx-summary");

const instance = getCleanInstance(30000);

/** JSON-RPC base URL from nodes catalog gateway */
const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** Cap SPL rows bundled into address overview (full list via GET …/token/:id with pagination). */
const MAX_SPL_IN_ADDRESS_OVERVIEW = 200;

/**
 * Nodo de NaaS, con el RPC de config como respaldo.
 *
 * Cuando el catalogo de NaaS no resuelve (o el nodo responde error), `getAddress`
 * devolvia null y el dashboard terminaba mostrando saldo 0 para billeteras que si
 * tienen fondos en la cadena. El respaldo mantiene la lectura funcionando.
 */
const solanaBookBase = async () => getNaasNodeUrl(NAAS_CHAIN.SOLANA);

/**
 * Se prefiere el nodo del proxy protegido (`/api/protected/rpc/solana`), que en
 * produccion si responde: es el que usa la extension para leer saldos. El de
 * `config.solana` queda de segundo porque puede no estar configurado.
 */
const solanaFallbackBase = () =>
	config.extension?.rpc?.chains?.solana?.rpcUrl || config.solana?.rpcUrl || "https://api.mainnet-beta.solana.com";

let rpcSeq = 0;
const rpcCall = async (method, params, { retried401 = false, useFallbackNode = false } = {}) => {
	let url;
	if (useFallbackNode) {
		url = solanaFallbackBase();
	} else {
		try {
			url = await solanaBookBase();
		} catch (err) {
			console.error("solana naas catalog:", err?.message || err);
			return rpcCall(method, params, { retried401, useFallbackNode: true });
		}
	}
	const id = ++rpcSeq;
	try {
		const { data } = await instance.post(
			url,
			{ jsonrpc: "2.0", id, method, params },
			{
				headers: {
					"Content-Type": "application/json",
					"user-agent": generateRandomUserAgent(),
				},
			},
		);
		if (data.error) {
			const err = new Error(data.error.message || JSON.stringify(data.error));
			err.rpcCode = data.error.code;
			throw err;
		}
		return data.result;
	} catch (err) {
		if (!useFallbackNode && !retried401 && isNaasNodeUnauthorizedError(err)) {
			try {
				await refreshNaasCatalogAfterUnauthorized();
				return rpcCall(method, params, { retried401: true });
			} catch (refreshErr) {
				console.error("solana naas catalog refresh:", refreshErr?.message || refreshErr);
				return rpcCall(method, params, { retried401: true, useFallbackNode: true });
			}
		}
		if (!useFallbackNode) {
			console.error("solana naas node:", err?.message || err);
			return rpcCall(method, params, { retried401, useFallbackNode: true });
		}
		throw err;
	}
};

function mapSignatureToTxRow(sig, ownerAddress) {
	const ts = sig.blockTime ?? 0;
	const status = sig.err ? "Failed" : "Success";
	return {
		hash: sig.signature,
		block: sig.slot != null ? String(sig.slot) : "",
		date: ts ? moment.unix(ts).format("YYYY-MM-DD HH:mm:ss") : "",
		age: ts ? moment.unix(ts).fromNow() : "",
		from: "",
		method: "signature",
		traffic: "",
		to: "",
		amount: 0,
		fiatAmount: "0",
		from_token_account: "",
		to_token_account: ownerAddress,
		status,
		asset: "SOL",
		timestamp: ts,
	};
}

function parsedTokenAccountsToHoldings(ownerAddress, value) {
	const rows = Array.isArray(value) ? value : [];
	const tokens = [];

	for (const row of rows) {
		const info = row?.account?.data?.parsed?.info;
		if (!info || info.state !== "initialized") continue;
		const ta = info.tokenAmount;
		if (!ta) continue;
		const raw = ta.amount != null ? String(ta.amount) : "0";
		const decimals = Number(ta.decimals ?? 0);
		const ui = ta.uiAmount != null ? Number(ta.uiAmount) : Number(raw) / 10 ** decimals;

		const mint = info.mint || "";
		const known = getKnownSplDisplay(mint);

		tokens.push({
			fiatBalance: 0,
			name: known?.name || `SPL ${mint.slice(0, 4)}…${mint.slice(-4)}`,
			amount: ui,
			price: 0,
			symbol: known?.symbol || "SPL",
			image: known?.image || "",
			address: row.pubkey,
			tokenAddress: mint,
			tokenType: "SPL",
			owner: ownerAddress,
		});
	}

	return {
		total: tokens.length,
		balance: 0,
		fiatBalance: 0,
		tokens,
	};
}

/**
 * Detail of each signature (direction, amount, asset). Without it every row went out as
 * "0 SOL" with no direction, and the apps showed "Recibido 0 SOL" for a 10 ZNS reward.
 *
 * Confirmed transactions never change, so the summary is cached per signature+wallet.
 * Lookups run a few at a time with a short deadline; a row that misses it keeps the
 * bare signature data instead of holding the whole response.
 */
const TX_SUMMARY_CACHE = new Map();
const TX_SUMMARY_CACHE_MAX = 5000;
const TX_DETAIL_CONCURRENCY = 6;
const TX_DETAIL_DEADLINE_MS = 4000;

const cacheSummary = (key, summary) => {
	if (TX_SUMMARY_CACHE.size >= TX_SUMMARY_CACHE_MAX) {
		TX_SUMMARY_CACHE.delete(TX_SUMMARY_CACHE.keys().next().value);
	}
	TX_SUMMARY_CACHE.set(key, summary);
};

const fetchTxSummary = async (signature, owner) => {
	const key = `${signature}:${owner}`;
	if (TX_SUMMARY_CACHE.has(key)) return TX_SUMMARY_CACHE.get(key);
	const tx = await rpcCall("getTransaction", [
		signature,
		{ encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
	]);
	const summary = summarizeParsedTransaction(tx, owner);
	if (summary) cacheSummary(key, summary);
	return summary;
};

/**
 * Fills traffic/amount/asset/from/to on rows from `mapSignatureToTxRow`.
 * @param {Array} rows
 * @param {string} owner
 * @param {number} [priceSol] - to fill `fiatAmount` on SOL rows
 */
const enrichTxRows = async (rows, owner, priceSol = 0) => {
	const queue = rows.filter((row) => row.status !== "Failed");
	const work = async () => {
		while (queue.length) {
			const row = queue.shift();
			try {
				const summary = await fetchTxSummary(row.hash, owner);
				if (!summary) continue;
				const { tokenMint, ...fields } = summary;
				Object.assign(row, fields);
				if (tokenMint) row.tokenMint = tokenMint;
				row.method = "transfer";
				if (summary.asset === "SOL" && priceSol) row.fiatAmount = (summary.amount * priceSol).toFixed(2);
			} catch (error) {
				console.warn("solana tx detail:", row.hash?.slice(0, 12), error?.message || error);
			}
		}
	};

	let timer;
	const deadline = new Promise((resolve) => {
		timer = setTimeout(resolve, TX_DETAIL_DEADLINE_MS);
	});
	const workers = Array.from({ length: Math.min(TX_DETAIL_CONCURRENCY, queue.length) }, work);
	await Promise.race([Promise.all(workers), deadline]).finally(() => clearTimeout(timer));
	// Rows still queued at the deadline keep their bare data; stop the workers.
	queue.length = 0;
	return rows;
};

const getSignatures = async (address, limit) => {
	const cap = Math.min(1000, Math.max(1, limit || 25));
	const result = await rpcCall("getSignaturesForAddress", [address, { limit: cap }]);
	return Array.isArray(result) ? result : [];
};

/** Native SOL only (no SPL scan / tx history) for fast fallback when scrapers lie about zero balance. */
const getNativeBalanceSummary = async (params) => {
	const address = params.id;
	const priceNum = await getTickerPrice({ symbol: "SOL" }).then(({ price }) => Number(price) || 0).catch(() => 0);
	const balRes = await rpcCall("getBalance", [address, { commitment: "confirmed" }]);
	const rawLamports = balRes != null && typeof balRes === "object" && "value" in balRes ? balRes.value : balRes;
	const balanceSol = Number(rawLamports) / 1e9;
	const fiatBalance = parseFloat((balanceSol * priceNum).toFixed(4));

	return {
		address,
		balance: `${balanceSol}`,
		fiatBalance,
		type: "system_account",
		account: {
			asset: "SOL",
			fiatBalance: fiatBalance.toFixed(5),
			price: `${priceNum}`,
		},
		tokenHoldings: {
			total: 1,
			balance: fiatBalance,
			fiatBalance,
			tokens: [
				{
					tokenType: "SOL",
					fiatBalance,
					symbol: "SOL",
					name: "Solana",
					price: priceNum,
					amount: balanceSol,
					image: "https://arweave.net/rO-delUT2hN1oigbIYe5nvZBaDYTvUoA-zbk623ksVg",
				},
			],
		},
		transactions: [],
	};
};

const getAddress = async (params) => {
	const address = params.id;
	const pricePromise = getTickerPrice({ symbol: "SOL" }).then(({ price }) => Number(price) || 0);
	// The history (signatures + per-transaction detail) runs alongside balance and tokens.
	const transactionsPromise = (async () => {
		const sigs = await getSignatures(address, 20);
		return enrichTxRows(
			sigs.map((s) => mapSignatureToTxRow(s, address)),
			address,
			await pricePromise.catch(() => 0),
		);
	})();
	// Don't leave a rejection unhandled if the balance call below throws first.
	transactionsPromise.catch(() => {});

	const balRes = await rpcCall("getBalance", [address, { commitment: "confirmed" }]);
	const rawLamports = balRes != null && typeof balRes === "object" && "value" in balRes ? balRes.value : balRes;
	const value = Number(rawLamports);
	const balanceSol = value / 1e9;

	const priceNum = await pricePromise;

	const tokenResult = await rpcCall("getTokenAccountsByOwner", [
		address,
		{ programId: SPL_TOKEN_PROGRAM },
		{ encoding: "jsonParsed" },
	]);
	const tokenHoldings = parsedTokenAccountsToHoldings(address, tokenResult?.value);
	await enrichSplTokenRowsWithJupiter(tokenHoldings.tokens);
	const splTotal = tokenHoldings.tokens.length;
	if (splTotal > MAX_SPL_IN_ADDRESS_OVERVIEW) {
		tokenHoldings.tokens = tokenHoldings.tokens.slice(0, MAX_SPL_IN_ADDRESS_OVERVIEW);
	}
	tokenHoldings.total = splTotal;

	const transactions = await transactionsPromise;

	const fiatBalance = parseFloat((balanceSol * priceNum).toFixed(4));

	const _response = {
		address,
		balance: `${balanceSol}`,
		fiatBalance,
		type: "system_account",
		account: {
			asset: "SOL",
			fiatBalance: fiatBalance.toFixed(5),
			price: `${priceNum}`,
		},
		tokenHoldings,
		transactions,
	};

	const hasSolToken = tokenHoldings.tokens.some((t) => t.tokenType === "SOL" && t.symbol === "SOL");
	if (!hasSolToken) {
		tokenHoldings.tokens.unshift({
			tokenType: "SOL",
			fiatBalance,
			symbol: "SOL",
			name: "Solana",
			price: priceNum,
			amount: balanceSol,
			image: "https://arweave.net/rO-delUT2hN1oigbIYe5nvZBaDYTvUoA-zbk623ksVg",
		});
	}

	if (tokenHoldings.fiatBalance) _response.fiatBalance += tokenHoldings.fiatBalance;
	_response.fiatBalance = parseFloat(Number(_response.fiatBalance).toFixed(4));

	return _response;
};

const getTokens = async (params, query = {}) => {
	const address = params.id;
	const page = Math.max(0, parseInt(String(query.page ?? "0"), 10) || 0);
	const show = Math.min(100, Math.max(1, parseInt(String(query.show ?? "50"), 10) || 50));

	const tokenResult = await rpcCall("getTokenAccountsByOwner", [
		address,
		{ programId: SPL_TOKEN_PROGRAM },
		{ encoding: "jsonParsed" },
	]);
	const full = parsedTokenAccountsToHoldings(address, tokenResult?.value);
	await enrichSplTokenRowsWithJupiter(full.tokens);
	const start = page * show;
	const slice = full.tokens.slice(start, start + show);
	return {
		total: full.total,
		balance: full.balance,
		fiatBalance: full.fiatBalance,
		tokens: slice,
	};
};

const getTransactions = async (params, query) => {
	const address = params.id;
	const page = parseInt(String(query.page), 10);
	const show = parseInt(String(query.show), 10);
	const limit = Math.min(1000, Math.max(1, Number.isFinite(show) ? show : 25));

	const sigs = await getSignatures(address, limit);
	const transactions = await enrichTxRows(
		sigs.map((s) => mapSignatureToTxRow(s, address)),
		address,
	);

	return {
		pagination: {
			records: String(transactions.length),
			pages: String(Number.isFinite(page) ? page : 0),
			page: Number.isFinite(page) ? page : 0,
		},
		transactions,
	};
};

module.exports = {
	enrichTxRows,
	solanaBookBase,
	getNativeBalanceSummary,
	getAddress,
	getTokens,
	getTransactions,
	parsedTokenAccountsToHoldings,
};
