const cheerio = require("cheerio");

require("dotenv").config();

const urlBase = process.env.MICROSERVICES_BOGOTA_URL;
const token = process.env.MICROSERVICES_BOGOTA_TOKEN;

const { getCleanInstance } = require("../../../Core/axios");
const {
	getNaasNodeUrl,
	NAAS_CHAIN,
	refreshNaasCatalogAfterUnauthorized,
	isNaasNodeUnauthorizedError,
	isNaasNodeInternalServerError,
	postNaasJsonRpcWith500Retries,
} = require("../../../Core/naas-gateway-catalog");
const { getTickerPrice } = require("../../binance/modules/binance.module");
const { get_ApiKey } = require("../../Solana/modules/oklink");
const etherscanChains = require("../../etherscan/chains.json");
const { getVerification, setVerification } = require("../../etherscan/modules/verification-cache.module");
const { formatUnits } = require("ethers");
const { getBalancesInSingleCall } = require("./bsc-multicall.module");
const { getPrices, priceForToken } = require("./bsc-prices.module");
const COMMON_TOKENS = require("../data/common-tokens.json");

const BSC_CHAIN_ID = (etherscanChains && etherscanChains["bsc-mainnet"]) || 56;

const baseUrl = "https://bscscan.com";
const instance = getCleanInstance(30000);
const bscscanApiKey = process.env.BSCSCAN_API_KEY;
const bscscanApiUrl = process.env.BSCSCAN_API_URL || "https://api.bscscan.com/api";
const bscRpcUrl = process.env.BSC_RPC_URL; // QuickNode only
/** Nodes catalog NaaS when BSC_RPC_URL fails or is unset */
const bscBookRpcBase = async () => getNaasNodeUrl(NAAS_CHAIN.SMARTCHAIN);
const CURATED_RPC_FALLBACK_MAX = Number(process.env.CURATED_RPC_FALLBACK_MAX || 6);
const BSCSCAN_BATCH_DELAY_MS = Number(process.env.BSCSCAN_BATCH_DELAY_MS || 350);

// Simple async sleep helper for batch spacing
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Debug helper (enable by setting DEBUG_BSC=1)
const dbgBsc = (...args) => {
	if (process.env.DEBUG_BSC === "1") {
		// eslint-disable-next-line no-console
		console.log("[bsc]", ...args);
	}
};

/** Try BSC_RPC_URL first, then catalog NaaS fallback */
async function postBscRpc(payload, options = {}) {
	const didRefresh401 = options.didRefresh401 ?? false;
	const didRefreshAfter500 = options.didRefreshAfter500 ?? false;

	const primary = bscRpcUrl || null;
	let fallback = null;
	try {
		fallback = await bscBookRpcBase();
	} catch (e) {
		dbgBsc("bsc_tw_gateway_error", e?.message || e);
	}
	const candidates = [...new Set([primary, fallback].filter(Boolean))];

	if (candidates.length === 0) return null;

	const naas500Attempts = Number(process.env.BSC_NAAS_HTTP_500_MAX_ATTEMPTS || 3);
	const naas500DelayMs = Number(process.env.BSC_NAAS_HTTP_500_RETRY_DELAY_MS || 300);

	for (const url of candidates) {
		try {
			let data;
			if (fallback && url === fallback) {
				data = await postNaasJsonRpcWith500Retries(instance, url, payload, {
					maxAttempts: naas500Attempts,
					delayMs: naas500DelayMs,
					onRetry: (attempt, max, u) =>
						dbgBsc("bsc_naas_http_500_retry", attempt, "/", max, u),
				});
			} else {
				const res = await instance.post(url, payload, {
					headers: { "Content-Type": "application/json" },
				});
				data = res.data;
			}

			if (data?.error) {
				dbgBsc("bsc_rpc_jsonrpc_error", url, data.error);
				continue;
			}

			return data;
		} catch (e) {
			if (
				!didRefresh401 &&
				isNaasNodeUnauthorizedError(e) &&
				fallback &&
				url === fallback
			) {
				await refreshNaasCatalogAfterUnauthorized();
				return postBscRpc(payload, { ...options, didRefresh401: true });
			}
			if (
				!didRefreshAfter500 &&
				fallback &&
				url === fallback &&
				isNaasNodeInternalServerError(e)
			) {
				await refreshNaasCatalogAfterUnauthorized();
				return postBscRpc(payload, { ...options, didRefreshAfter500: true });
			}
			dbgBsc("bsc_rpc_transport_error", url, e?.message || e);
		}
	}

	return null;
}

const {
	COMMON_TOKENS_BSC,
	COMMON_TOKEN_ID_BY_ADDRESS_BSC,
	COMMON_TOKEN_DECIMALS_BY_ADDRESS_BSC,
	COMMON_TOKEN_METADATA_BY_ADDRESS_BSC,
	isCommonBscToken,
	isLikelyScamTokenName,
	USDT,
	USDC,
	BUSD,
	DAI,
	WBNB,
	BTCB,
	ETH_PEG,
} = require("./bsc-tokens.constants");

/**
 * Fetch USD prices from CoinGecko for a list of BEP-20 contract addresses
 * Returns a Map<lowercasedContractAddress, usdPrice>
 */
async function getCoinGeckoPricesForContracts(contractAddresses) {
	try {
		if (!Array.isArray(contractAddresses) || contractAddresses.length === 0) {
			return new Map();
		}

		const uniqueAddresses = Array.from(new Set(contractAddresses.map((addr) => (addr || "").toLowerCase()))).filter(Boolean);

		const chunkSize = 100; // CoinGecko supports large batches; keep conservative
		const priceMap = new Map();

		for (let i = 0; i < uniqueAddresses.length; i += chunkSize) {
			const chunk = uniqueAddresses.slice(i, i + chunkSize);
			const url = `https://api.coingecko.com/api/v3/simple/token_price/binance-smart-chain?contract_addresses=${chunk.join(
				","
			)}&vs_currencies=usd`;

			const { data } = await instance.get(url);

			// data is an object keyed by lowercased contract address
			Object.entries(data || {}).forEach(([address, value]) => {
				const usd = value && typeof value.usd === "number" ? value.usd : 0;

				if (!usd) return;

				priceMap.set(address.toLowerCase(), usd);
			});
		}

		return priceMap;
	} catch (error) {
		// If CoinGecko fails (rate limits, network), return empty to avoid breaking the flow
		console.error({ coingecko_price_fetch_error: error?.message || error });

		return new Map();
	}
}

async function getCoinGeckoPricesForIds(ids) {
	try {
		if (!Array.isArray(ids) || ids.length === 0) return new Map();

		const unique = Array.from(new Set(ids.filter(Boolean)));
		const chunkSize = 100;
		const priceMap = new Map();

		for (let i = 0; i < unique.length; i += chunkSize) {
			const chunk = unique.slice(i, i + chunkSize);
			const url = `https://api.coingecko.com/api/v3/simple/price?ids=${chunk.join(",")}&vs_currencies=usd`;
			const { data } = await instance.get(url);

			Object.entries(data || {}).forEach(([id, value]) => {
				const usd = value && typeof value.usd === "number" ? value.usd : 0;

				if (!usd) return;

				priceMap.set(id, usd);
			});
		}

		return priceMap;
	} catch (error) {
		console.error({ coingecko_id_price_fetch_error: error?.message || error });

		return new Map();
	}
}

// OKLink fallback: fetch BEP-20 token holdings for BSC
async function getOklinkFormattedTokens(address, limit = 100) {
	try {
		const t = Date.now();
		const url = `https://www.oklink.com/api/explorer/v2/bsc/addresses/${address}/tokens?offset=0&limit=${limit}&t=${t}`;

		const { data } = await instance.get(url, {
			headers: {
				"X-Apikey": get_ApiKey().getApiKey(),
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
			},
		});

		if (!(data?.code === "0" || data?.code === 0) || !Array.isArray(data?.data?.hits)) return [];

		const hits = data.data.hits;

		const formatted = hits
			.map((tok) => {
				const addr = String(tok.contractAddress || "").toLowerCase();

				if (!addr) return null;

				const decimals = parseInt(tok.decimals || 18);
				const rawAmount = Number(tok.holdingAmount || 0);
				const amount = rawAmount / Math.pow(10, decimals);

				let price = Number(tok.price || 0);

				if ((!price || price === 0) && (addr === USDT || addr === USDC || addr === BUSD)) price = 1;

				const fiatBalance = amount * price;
				const meta = COMMON_TOKEN_METADATA_BY_ADDRESS_BSC.get(addr) || {};

				return {
					_amount: amount,
					_fiatBalance: fiatBalance.toFixed(Math.min(decimals, 8)),
					_price: price,
					address: addr,
					amount: amount.toFixed(Math.min(decimals, 12)),
					decimals: decimals,
					fiatBalance: fiatBalance,
					image: tok.logo || meta.image || "",
					name: tok.tokenName || tok.symbol || meta.name || "",
					price: price,
					symbol: tok.symbol || meta.symbol || "",
					tokenType: "BEP-20",
				};
			})
			.filter(Boolean)
			.sort((a, b) => Number(b.fiatBalance) - Number(a.fiatBalance));

		return formatted;
	} catch (error) {
		dbgBsc("oklink_tokens_error", error?.message || error);

		return [];
	}
}

// Minimal JSON-RPC call to fetch BEP-20 balance via balanceOf(address)
async function getBep20BalanceViaRpc(contractAddress, userAddress) {
	try {
		const methodId = "0x70a08231"; // balanceOf(address)
		const addressHex = String(userAddress).toLowerCase().replace(/^0x/, "");
		const data = methodId + "000000000000000000000000" + addressHex;

		const payload = {
			jsonrpc: "2.0",
			id: 0,
			method: "eth_call",
			params: [{ to: contractAddress, data }, "latest"],
		};

		const rpc = await postBscRpc(payload);
		const hex = rpc?.result || "0x0";

		return hex === "0x" ? "0x0" : hex;
	} catch (error) {
		dbgBsc("rpc_balance_error", bscRpcUrl || "naas_smartchain_fallback", contractAddress, error?.message || error);

		return "0x0";
	}
}

// Batch BEP-20 balances via eth_call
async function getBep20BalancesViaRpcBatch(contracts, userAddress) {
	if (!Array.isArray(contracts) || contracts.length === 0) return new Map();

	const methodId = "0x70a08231";
	const addressHex = String(userAddress).toLowerCase().replace(/^0x/, "");

	const calls = contracts.map((c, i) => ({
		jsonrpc: "2.0",
		id: i + 1,
		method: "eth_call",
		params: [{ to: c, data: methodId + "000000000000000000000000" + addressHex }, "latest"],
	}));

	try {
		const results = await Promise.all(calls.map((payload) => postBscRpc(payload).catch(() => null)));

		const map = new Map();

		for (let i = 0; i < contracts.length; i++) {
			const res = results[i];
			const hex = res?.result || "0x0";

			map.set(String(contracts[i]).toLowerCase(), hex === "0x" ? "0x0" : hex);
		}

		return map;
	} catch (_) {
		return new Map();
	}
}

// Native balance via RPC
async function getNativeBalanceViaRpc(userAddress) {
	try {
		const payload = {
			jsonrpc: "2.0",
			id: 0,
			method: "eth_getBalance",
			params: [userAddress, "latest"],
		};

		const rpc = await postBscRpc(payload);
		if (!rpc?.result) return 0;

		const hex = rpc.result || "0x0";
		const wei = hex && typeof hex === "string" && hex.startsWith("0x") ? parseInt(hex, 16) : Number(hex || 0);

		return Number(wei);
	} catch (error) {
		dbgBsc("rpc_native_balance_error", userAddress, error?.message || error);

		return 0;
	}
}

/**
 * Determine which contracts are verified on BscScan.
 * Returns a Set of lowercased addresses that are verified.
 * If no API key is configured, returns an empty Set (no filtering will rely solely on this).
 */
async function getBscVerifiedContracts(contractAddresses) {
	try {
		if (!bscscanApiKey) return new Set();

		const uniqueAddresses = Array.from(new Set((contractAddresses || []).map((addr) => (addr || "").toLowerCase()))).filter(Boolean);

		const concurrency = 3;
		const verified = new Set();

		for (let i = 0; i < uniqueAddresses.length; i += concurrency) {
			const batch = uniqueAddresses.slice(i, i + concurrency);

			const results = await Promise.all(
				batch.map(async (address) => {
					// Try cache first
					try {
						const cached = await getVerification(BSC_CHAIN_ID, address);

						if (cached && typeof cached.isVerified === "boolean") {
							if (cached.isVerified) return address;

							return null;
						}
					} catch (_) {}

					try {
						const url = `${bscscanApiUrl}?module=contract&action=getsourcecode&address=${address}&apikey=${bscscanApiKey}`;
						const { data } = await instance.get(url);
						const item = Array.isArray(data?.result) ? data.result[0] : null;
						const abi = item?.ABI;

						if (!abi || typeof abi !== "string" || abi === "Contract source code not verified") {
							await setVerification(BSC_CHAIN_ID, address, false, "bscscan");

							return null;
						}

						await setVerification(BSC_CHAIN_ID, address, true, "bscscan");

						return address;
					} catch (err) {
						// Ignore per-address errors to avoid failing the whole batch
					}

					return null;
				})
			);

			results.filter(Boolean).forEach((addr) => verified.add(addr));

			// Space batches to reduce BscScan 429 risk
			if (i + concurrency < uniqueAddresses.length) await sleep(BSCSCAN_BATCH_DELAY_MS);
		}

		return verified;
	} catch (error) {
		console.error({ bscscan_verification_error: error?.message || error });

		return new Set();
	}
}

/** Stables and wrapped majors first, then the rest of the curated list; cap to `max` entries. */
function prioritizeCuratedBscForRpc(max) {
	if (max <= 0) return [];

	const allLower = Array.from(COMMON_TOKENS_BSC).map((a) => String(a).toLowerCase());
	const allSet = new Set(allLower);
	const priority = [USDT, USDC, BUSD, WBNB, DAI, BTCB, ETH_PEG].map((a) => a.toLowerCase());
	const out = [];

	for (const p of priority) {
		if (allSet.has(p) && !out.includes(p)) out.push(p);

		if (out.length >= max) return out;
	}

	for (const a of allLower) {
		if (!out.includes(a)) out.push(a);

		if (out.length >= max) break;
	}

	return out;
}

/**
 * Legacy explorer path (NodeReal + CoinGecko + BscScan verification). Only used when every BSC RPC is down.
 * Kept unchanged so the emergency behaviour matches what production returned before.
 */
const getBalanceLegacy = async (params) => {
	try {
		const address = params.id;
		const { price } = await getTickerPrice({ symbol: "BNB" });

		// Native balance: NodeReal → RPC fallback
		let nativeWei = 0;

		try {
			const { data } = await instance.get(`https://bsc-explorer-api.nodereal.io/api/token/getBalance?address=${address}`);

			nativeWei = Number(BigInt(data?.data || 0));
		} catch (_) {
			dbgBsc("nodereal_balance_down_use_rpc");

			nativeWei = await getNativeBalanceViaRpc(address);
		}

		// Tokens: NodeReal → OKLink → curated RPC batch
		let tokens = [];

		try {
			tokens = await getTokens({ id: address });
		} catch (_) {
			dbgBsc("nodereal_tokens_down_try_oklink");
			tokens = await getOklinkFormattedTokens(address, 100);
		}

		if (!tokens || tokens.length === 0) {
			// Skip curated RPC batch for empty wallets — no point spamming eth_call
			if (nativeWei > 0) {
				const prioritized = prioritizeCuratedBscForRpc(CURATED_RPC_FALLBACK_MAX);
				const rpcBalances = await getBep20BalancesViaRpcBatch(prioritized, address);
				const added = [];

				for (const contract of prioritized) {
					const raw = rpcBalances.get(contract) || "0x0";
					const numericRaw = typeof raw === "string" && raw.startsWith("0x") ? parseInt(raw, 16) : Number(raw);

					if (!numericRaw) continue;

					const decimals = COMMON_TOKEN_DECIMALS_BY_ADDRESS_BSC.get(contract) || 18;
					const amount = Number(numericRaw) / Math.pow(10, decimals);

					if (amount <= 0) continue;

					const id = COMMON_TOKEN_ID_BY_ADDRESS_BSC.get(contract);

					let p = 0;

					if (id) {
						const idPrices = await getCoinGeckoPricesForIds([id]);

						p = idPrices.get(id) || 0;
					}

					if ((!p || p === 0) && (contract === USDT || contract === USDC || contract === BUSD)) p = 1;

					const fiatBalance = amount * p;
					const meta = COMMON_TOKEN_METADATA_BY_ADDRESS_BSC.get(contract) || {};

					tokens.push({
						_amount: amount,
						_fiatBalance: fiatBalance.toFixed(Math.min(decimals, 8)),
						_price: Number(p),
						address: contract,
						amount: amount.toFixed(Math.min(decimals, 12)),
						decimals: decimals,
						fiatBalance: fiatBalance,
						image: meta.image || "",
						name: meta.name || "",
						price: p,
						symbol: meta.symbol || "",
						tokenType: "BEP-20",
					});
					added.push(contract);
				}
				dbgBsc("rpcFallbackAdded", added.length, added);
			} else {
				dbgBsc("skippedRpcFallback_zeroNativeBalance");
			}
		}

		const BSCValue = Number(nativeWei) / 1e18;
		const fiatBalance = BSCValue * price;
		const totalFiatBalance = Number(tokens.reduce((s, t) => s + Number(t.fiatBalance || t._fiatBalance || 0), 0).toFixed(8));

		tokens.push({
			amount: BSCValue.toString(),
			fiatBalance: fiatBalance,
			image: "https://dynamic-assets.coinbase.com/36f266bc4826775268588346777c84c1ae035e7de268a6e124bcc22659f0aa2bf4f66dcad89b2ac978cfdb4d51c2d9f63cf7157769efb500b20ca16a6d5719c7/asset_icons/7deb6ff58870072405c0418d85501c4521c3296e33ef58452be98e4ca592ed19.png",
			name: "Binance",
			price: price,
			symbol: "BNB",
			tokenType: "BNB",
		});

		const transactions = await getTransactionsList({ id: address }, { show: "10" });

		return {
			address,
			balance: BSCValue,
			fiatBalance,
			account: { asset: "BNB", fiatBalance: fiatBalance.toString(), price },
			tokenHoldings: { total: tokens.length, balance: totalFiatBalance, tokens },
			transactions: transactions.transactions,
		};
	} catch (error) {
		console.error({ error });
	}
};

const BNB_IMAGE =
	"https://dynamic-assets.coinbase.com/36f266bc4826775268588346777c84c1ae035e7de268a6e124bcc22659f0aa2bf4f66dcad89b2ac978cfdb4d51c2d9f63cf7157769efb500b20ca16a6d5719c7/asset_icons/7deb6ff58870072405c0418d85501c4521c3296e33ef58452be98e4ca592ed19.png";
const NATIVE_BNB = { symbol: "BNB", priceSymbol: "BNB", coingeckoId: "binancecoin" };

// Once balances are ready, wait at most this long for history; otherwise answer with the cached list (or []).
const TX_GRACE_MS = Number(process.env.BSC_TX_GRACE_MS || 500);
const TX_CACHE_MS = Number(process.env.BSC_TX_CACHE_MS || 60000);
const BALANCE_CACHE_MS = Number(process.env.BSC_BALANCE_CACHE_MS || 10000);

const txCache = new Map(); // address -> { transactions, at }
const txInflight = new Map(); // address -> Promise<transactions[]>
const balanceCache = new Map(); // address -> { data, at }
const balanceInflight = new Map(); // address -> Promise<data>

/** Recent BNB transactions (current sources: OKLink → BscScan → Bogotá), cached per address, one fetch in flight per address. */
const fetchRecentTransactions = (address) => {
	const key = address.toLowerCase();
	const cached = txCache.get(key);

	if (cached && Date.now() - cached.at <= TX_CACHE_MS) return Promise.resolve(cached.transactions);

	if (txInflight.has(key)) return txInflight.get(key);

	const p = getTransactionsList({ id: address }, { show: "10" })
		.then((r) => {
			const transactions = Array.isArray(r?.transactions) ? r.transactions : [];

			txCache.set(key, { transactions, at: Date.now() });

			return transactions;
		})
		.catch(() => cached?.transactions || [])
		.finally(() => txInflight.delete(key));

	txInflight.set(key, p);

	return p;
};

/**
 * Never let history block balances: called once balances are ready, waits at most TX_GRACE_MS more, then answers with
 * the last cached list (or []). The fetch keeps running and fills the cache for the next call.
 */
const transactionsWithinGrace = async (address, pending) => {
	let timer;
	const timeout = new Promise((resolve) => {
		timer = setTimeout(() => resolve(txCache.get(address.toLowerCase())?.transactions || []), TX_GRACE_MS);
	});

	try {
		return await Promise.race([pending, timeout]);
	} finally {
		clearTimeout(timer);
	}
};

/** Same token shape the explorer path returned (the extension reads these fields as-is). */
const formatCommonToken = (token, rawBalance, price) => {
	const amount = Number(formatUnits(rawBalance, token.decimals));
	const fiatBalance = amount * price;

	return {
		_amount: amount,
		_fiatBalance: fiatBalance.toFixed(7),
		_price: price,
		address: token.contractAddress.toLowerCase(),
		amount: amount.toFixed(12),
		decimals: token.decimals,
		fiatBalance: parseFloat(fiatBalance.toFixed(7)),
		image: token.image || "",
		name: token.name,
		price: price.toFixed(6),
		symbol: token.symbol,
		tokenType: "BEP-20",
	};
};

/**
 * Fast path: native BNB + curated BEP-20 balances in ONE Multicall3 eth_call, prices from one cached batch,
 * transactions fetched in parallel and never allowed to block balances. Response shape unchanged.
 */
const getBalanceFast = async (address) => {
	const pendingTransactions = fetchRecentTransactions(address); // starts now, in parallel with balances

	const [{ nativeWei, tokenBalances }, prices] = await Promise.all([getBalancesInSingleCall(address, COMMON_TOKENS), getPrices([NATIVE_BNB, ...COMMON_TOKENS])]);

	const tokens = COMMON_TOKENS.filter((t) => (tokenBalances.get(t.contractAddress.toLowerCase()) || 0n) > 0n)
		.map((t) => formatCommonToken(t, tokenBalances.get(t.contractAddress.toLowerCase()), priceForToken(t, prices)))
		.sort((a, b) => Number(b.fiatBalance) - Number(a.fiatBalance));

	const price = priceForToken(NATIVE_BNB, prices);
	const BSCValue = Number(formatUnits(nativeWei, 18));
	const fiatBalance = BSCValue * price;
	const totalFiatBalance = Number(tokens.reduce((s, t) => s + Number(t.fiatBalance || t._fiatBalance || 0), 0).toFixed(8));

	tokens.push({
		amount: BSCValue.toString(),
		fiatBalance: fiatBalance,
		image: BNB_IMAGE,
		name: "Binance",
		price: price,
		symbol: "BNB",
		tokenType: "BNB",
	});

	const transactions = await transactionsWithinGrace(address, pendingTransactions);

	return {
		address,
		balance: BSCValue,
		fiatBalance,
		account: { asset: "BNB", fiatBalance: fiatBalance.toString(), price },
		tokenHoldings: { total: tokens.length, balance: totalFiatBalance, tokens },
		transactions,
	};
};

/**
 * GET /bsc/address/:id — short per-address cache (Home and Wallet ask for the same address back to back) and
 * one computation in flight per address. Falls back to the legacy explorer path only if every RPC is down.
 */
const getBalance = async (params) => {
	const address = params.id;
	const key = String(address).toLowerCase();
	const cached = balanceCache.get(key);

	if (cached && Date.now() - cached.at <= BALANCE_CACHE_MS) return cached.data;

	if (balanceInflight.has(key)) return balanceInflight.get(key);

	const p = (async () => {
		try {
			const data = await getBalanceFast(address);

			balanceCache.set(key, { data, at: Date.now() });

			return data;
		} catch (error) {
			console.error({ bsc_fast_balance_error: error?.message || error });

			return getBalanceLegacy(params);
		}
	})().finally(() => balanceInflight.delete(key));

	balanceInflight.set(key, p);

	return p;
};

/** Test helper: clear per-address caches. */
const _resetBscCaches = () => {
	txCache.clear();
	txInflight.clear();
	balanceCache.clear();
	balanceInflight.clear();
};

const getTokens = async (params) => {
	try {
		const address = params.id;

		const { data } = await instance.get(`https://bsc-explorer-api.nodereal.io/api/token/getTokensByAddress?address=${address}&pageSize=0x64`);

		const erc20Tokens = (data?.data?.erc20?.details || []).filter(Boolean);
		const contractAddresses = erc20Tokens.map((t) => t?.tokenAddress).filter(Boolean);

		// Replace Nodereal-provided prices with CoinGecko prices by contract
		const coingeckoPriceMap = await getCoinGeckoPricesForContracts(contractAddresses);

		// Query BscScan for source-code verification of contracts
		const bscVerifiedSet = await getBscVerifiedContracts(contractAddresses);

		// Fallback: fetch prices by CoinGecko ID for common tokens missing from contract-based map
		const missingCommonAddrs = contractAddresses
			.map((a) => (a || "").toLowerCase())
			.filter((a) => isCommonBscToken(a) && !coingeckoPriceMap.has(a));

		const idsToFetch = missingCommonAddrs.map((a) => COMMON_TOKEN_ID_BY_ADDRESS_BSC.get(a)).filter(Boolean);

		if (idsToFetch.length) {
			const idPrices = await getCoinGeckoPricesForIds(idsToFetch);

			missingCommonAddrs.forEach((addr) => {
				const id = COMMON_TOKEN_ID_BY_ADDRESS_BSC.get(addr);
				const usd = id ? idPrices.get(id) : 0;

				if (!usd) return;

				coingeckoPriceMap.set(addr, usd);
			});
		}

		const formattedTokens = formatTokens(data.data, coingeckoPriceMap);

		// Hide tokens without a reliable price and those matching suspicious name patterns
		// Keep tokens that are either BscScan-verified OR present on CoinGecko (have price)
		const visibleTokens = formattedTokens
			// Always keep curated common tokens even if CoinGecko price is unavailable
			.filter((t) => isCommonBscToken(t.address) || Number(t._price) > 0)
			// Allow common tokens to bypass heuristic name filter
			.filter((t) => isCommonBscToken(t.address) || !isLikelyScamTokenName(t.name, t.symbol))
			.filter((t) => {
				const addr = (t.address || "").toLowerCase();
				const hasCgPrice = Number(t._price) > 0;
				const isVerified = bscVerifiedSet.has(addr);
				const isCommon = isCommonBscToken(addr);
				// If API key present: allow Verified OR CG-priced OR curated common list
				// If no API key: allow CG-priced OR curated common list

				return bscscanApiKey ? isVerified || hasCgPrice || isCommon : hasCgPrice || isCommon;
			})
			.sort((a, b) => Number(b.fiatBalance) - Number(a.fiatBalance));

		return visibleTokens;
	} catch (error) {
		console.error({ error });
	}
};

function formatTokens(data, coingeckoPriceMap = new Map()) {
	const erc20Tokens = data.erc20.details || [];

	return erc20Tokens.map((token) => {
		const decimals = parseInt(token.tokenDecimals, 16); // De hexadecimal a número
		const rawBalance = BigInt(token.tokenBalance); // Balance en BigInt
		const amount = Number(rawBalance) / Math.pow(10, decimals); // Balance en unidades normales

		// Prefer CoinGecko price by contract; fallback to 0 if unavailable
		const contractAddress = (token.tokenAddress || "").toLowerCase();
		const priceFromCg = coingeckoPriceMap.get(contractAddress) || 0;
		const price = priceFromCg;
		const fiatBalance = amount * price;

		return {
			_amount: amount,
			_fiatBalance: fiatBalance.toFixed(7),
			_price: price,
			address: token.tokenAddress,
			amount: amount.toFixed(12),
			decimals: decimals,
			fiatBalance: parseFloat(fiatBalance.toFixed(7)),
			image: "", // Puedes después añadir un fetch a CoinMarketCap o una API para obtener imágenes
			name: token.tokenName,
			price: price.toFixed(6),
			symbol: token.tokenSymbol.length <= 10 ? token.tokenSymbol : token.tokenSymbol.substring(0, 10), // Limitamos símbolo si es muy largo
			tokenType: "BEP-20",
		};
	});
}

const getGasTracker = async () => {
	try {
		let { data } = await instance.get(`${baseUrl}/gastracker`, {
			headers: {
				"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
				"Upgrade-Insecure-Requests": "1",
			},
		});

		const $ = cheerio.load(data);

		const lowGwei = $("#spanLowPrice").text().replace(/\n/g, "").trim();
		const averageGwei = $("#spanAvgPrice").text().replace(/\n/g, "").trim();
		const highGwei = $("#spanHighPrice").text().replace(/\n/g, "").trim();

		const lowTime = $("#divLowPrice > div.text-muted").first().text().replace(/\n/g, "").trim().trim();

		const averageTime = $("#divAvgPrice > div.text-muted").text().replace(/\n/g, "").trim().trim();

		const highTime = $("#divHighPrice > div.text-muted").text().replace(/\n/g, "").trim().trim();

		const featuredActions = [];

		$("#content > section.container-xxl.pb-16 > div.row.g-4.mb-4 > div:nth-child(2) > div > div > div:nth-child(2) > div > table tr").each(
			(_index, element) => {
				const action = $(element).find("td span").text().trim();
				const low = $(element).find("td").eq(1).text().replace("$", "").trim();
				const average = $(element).find("td").eq(2).text().replace("$", "").trim();
				const high = $(element).find("td").eq(3).text().replace("$", "").trim();

				if (action) {
					featuredActions.push({
						action,
						low,
						average,
						high,
					});
				}
			}
		);

		const response = {
			low: {
				gwei: lowGwei,
				time: lowTime,
			},
			average: {
				gwei: averageGwei,
				time: averageTime,
			},
			high: {
				gwei: highGwei,
				time: highTime,
			},
			featuredActions,
		};

		return response;
	} catch (error) {
		console.error({ error: error });
	}
};

/**
 * get transaction status
 * @param {Object} params
 */
const getTransactionStatus = async (params) => {
	try {
		const id = params.id;

		const { data } = await instance.get(`${urlBase}/api/evm-tx/bsc-transaction?address=${id}`, {
			headers: {
				Authorization: `Bearer ${token}`,
			},
		});

		return data;
	} catch (exception) {
		const error = new Error("transaction_not_found");

		error.status = 404;

		throw error;
	}
};

// Fetch BSC transactions via OKLink
async function getOklinkBscTransactions(address, page, show, price) {
	try {
		const t = Date.now();
		const url = `https://www.oklink.com/api/explorer/v2/bsc/addresses/${address}/transactionsByClassfy/condition?offset=${page}&limit=${show}&address=${address}&nonzeroValue=false&t=${t}`;
		const { data } = await instance.get(url, {
			headers: {
				"X-Apikey": get_ApiKey().getApiKey(),
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
			},
		});

		if ((data?.code === "0" || data?.code === 0) && data?.data?.hits) {
			const hits = data.data.hits;
			const transactions = hits.map((tx) => {
				const value = Number(tx.value || 0);
				const fiatValue = value * Number(price || 0);
				const traffic = String(tx.from || "").toLowerCase() === String(address).toLowerCase() ? "OUT" : "IN";

				return {
					age: tx.blocktime ? new Date(tx.blocktime * 1000).toISOString() : "",
					amount: value ? String(value) : "0",
					asset: "BNB",
					block: String(tx.blockHeight || ""),
					date: tx.blocktime ? new Date(tx.blocktime * 1000).toISOString().replace("T", " ").slice(0, 19) : "",
					fiatAmount: fiatValue.toFixed(2),
					from: tx.from,
					hash: tx.hash,
					method: tx.method || "Transfer",
					to: tx.to,
					traffic,
					txnFee: tx.fee ? String(Number(tx.fee)) : "0",
				};
			});

			return { pagination: { records: String(transactions.length), pages: "1", page: String(page) }, transactions };
		}

		return null;
	} catch (error) {
		dbgBsc("oklink_tx_error", error?.message || error);

		return null;
	}
}

// Fetch BSC transactions via BscScan
async function getBscscanTransactions(address, page, show, price) {
	try {
		if (!bscscanApiKey) return null;

		const apikey = `&apikey=${bscscanApiKey}`;
		const url = `${bscscanApiUrl}?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=${page}&offset=${show}&sort=desc${apikey}`;
		const { data } = await instance.get(url);

		if (data?.status === "1" && Array.isArray(data?.result)) {
			const txs = data.result.map((tx) => {
				const value = Number(tx.value || 0) / Math.pow(10, 18);
				const fiatValue = value * Number(price || 0);
				const traffic = String(tx.from || "").toLowerCase() === String(address).toLowerCase() ? "OUT" : "IN";

				let txnFee = "0";
				const gasUsed = Number(tx.gasUsed || 0);
				const gasPrice = Number(tx.gasPrice || 0);

				if (gasUsed && gasPrice) txnFee = ((gasUsed * gasPrice) / Math.pow(10, 18)).toFixed(8);

				return {
					age: tx.timeStamp ? new Date(Number(tx.timeStamp) * 1000).toISOString() : "",
					amount: value ? String(value) : "0",
					asset: "BNB",
					block: String(tx.blockNumber || ""),
					date: tx.timeStamp ? new Date(Number(tx.timeStamp) * 1000).toISOString().replace("T", " ").slice(0, 19) : "",
					fiatAmount: fiatValue.toFixed(2),
					from: tx.from,
					hash: tx.hash,
					method: tx.methodId ? "Contract Interaction" : "Transfer",
					to: tx.to,
					traffic,
					txnFee,
				};
			});

			return { pagination: { records: String(txs.length), pages: "1", page: String(page) }, transactions: txs };
		}

		return null;
	} catch (error) {
		dbgBsc("bscscan_tx_error", error?.message || error);

		return null;
	}
}

/**
 * get transactions list
 * @param {Object} params
 * @returns
 */
const getTransactionsList = async (params, query) => {
	const address = params.id;
	const page = query.page || 0;
	const show = query.show || 10;

	try {
		// Get current BNB price for fiat calculation
		let price = 0;

		try {
			price = priceForToken(NATIVE_BNB, await getPrices([NATIVE_BNB]));
		} catch (_) {}

		// Try OKLink first
		let resp = await getOklinkBscTransactions(address, page, show, price);

		if (resp && resp.transactions && resp.transactions.length > 0) return resp;

		// Fallback to BscScan
		resp = await getBscscanTransactions(address, page, show, price);

		if (resp && resp.transactions && resp.transactions.length > 0) return resp;

		// Final fallback: internal Bogotá microservice
		try {
			const { data } = await instance.get(`${urlBase}/api/evm-tx/bsc-transactions?address=${address}&show=${show}`, {
				headers: token ? { Authorization: `Bearer ${token}` } : {},
			});

			return { pagination: { records: String(data?.length || 0), pages: "1", page: String(page) }, transactions: data || [] };
		} catch (_) {}

		return { pagination: { records: "0", pages: "0", page: String(page) }, transactions: [] };
	} catch (error) {
		console.error({ error });

		return { pagination: { records: "0", pages: "0", page: String(page) }, transactions: [] };
	}
};

module.exports = {
	_resetBscCaches,
	getBalance,
	getBalanceFast,
	getBalanceLegacy,
	getGasTracker,
	getTransactionsList,
	getTransactionStatus,
};
