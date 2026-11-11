require("dotenv").config();

const cheerio = require("cheerio");
const moment = require("moment");

const { getCleanInstance } = require("../../../Core/axios");
const {
	getNaasNodeUrl,
	NAAS_CHAIN,
	refreshNaasCatalogAfterUnauthorized,
	isNaasNodeUnauthorizedError,
	isNaasNodeInternalServerError,
	postNaasJsonRpcWith500Retries,
} = require("../../../Core/naas-gateway-catalog");
const config = require("../../../Core/config");
const { getTickerPrice } = require("../../binance/modules/binance.module");
const { get_ApiKey } = require("../../Solana/modules/oklink");

const baseUrl = "https://polygonscan.com";
const instance = getCleanInstance(30000);

const etherscanChains = require("../../etherscan/chains.json");

const POLYGON_CHAIN_ID = (etherscanChains && etherscanChains["polygon-mainnet"]) || 137;

const { getVerification, setVerification } = require("../../etherscan/modules/verification-cache.module");

const urlBase = process.env.MICROSERVICES_BOGOTA_URL;
const token = process.env.MICROSERVICES_BOGOTA_TOKEN;

const polygonscanApiKey = process.env.POLYGONSCAN_API_KEY || process.env.ETHERSCAN_API_KEY || config?.etherscan?.apiKey;
const polygonscanApiUrl = process.env.POLYGONSCAN_API_URL || process.env.ETHERSCAN_V2_API || "https://api.etherscan.io/v2/api";

const polygonRpcUrl = process.env.POLYGON_RPC_URL; // QuickNode only, no public RPCs

/** Nodes catalog NaaS JSON-RPC when POLYGON_RPC_URL fails or is unset */
const polygonBookRpcBase = async () => getNaasNodeUrl(NAAS_CHAIN.POLYGON);

const POLYGONSCAN_BATCH_DELAY_MS = Number(process.env.POLYGONSCAN_BATCH_DELAY_MS || 350);
const CURATED_RPC_FALLBACK_MAX = Number(process.env.CURATED_RPC_FALLBACK_MAX || 6);

// Conditional debug logger — set DEBUG_POLYGON=1 to enable (no-op in production).
const logPolygonDebug = (...args) => {
	if (process.env.DEBUG_POLYGON === "1") {
		// eslint-disable-next-line no-console
		console.log("[polygon]", ...args);
	}
};

// Simple async sleep helper for batch spacing
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Try primary POLYGON_RPC_URL first, then catalog NaaS fallback; returns JSON-RPC response body or null */
async function postPolygonRpc(payload, options = {}) {
	const didRefresh401 = options.didRefresh401 ?? false;
	const didRefreshAfter500 = options.didRefreshAfter500 ?? false;

	const primary = polygonRpcUrl || null;
	let fallback = null;
	try {
		fallback = await polygonBookRpcBase();
	} catch (e) {
		logPolygonDebug("polygon_tw_gateway_error", e?.message || e);
	}
	const candidates = [...new Set([primary, fallback].filter(Boolean))];

	if (candidates.length === 0) return null;

	const naas500Attempts = Number(process.env.POLYGON_NAAS_HTTP_500_MAX_ATTEMPTS || 3);
	const naas500DelayMs = Number(process.env.POLYGON_NAAS_HTTP_500_RETRY_DELAY_MS || 300);

	for (const url of candidates) {
		try {
			let data;
			if (fallback && url === fallback) {
				data = await postNaasJsonRpcWith500Retries(instance, url, payload, {
					maxAttempts: naas500Attempts,
					delayMs: naas500DelayMs,
					onRetry: (attempt, max, u) =>
						logPolygonDebug("polygon_naas_http_500_retry", attempt, "/", max, u),
				});
			} else {
				const res = await instance.post(url, payload, {
					headers: { "Content-Type": "application/json" },
				});
				data = res.data;
			}

			if (data?.error) {
				logPolygonDebug("polygon_rpc_jsonrpc_error", url, data.error);
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
				return postPolygonRpc(payload, { ...options, didRefresh401: true });
			}
			if (
				!didRefreshAfter500 &&
				fallback &&
				url === fallback &&
				isNaasNodeInternalServerError(e)
			) {
				await refreshNaasCatalogAfterUnauthorized();
				return postPolygonRpc(payload, { ...options, didRefreshAfter500: true });
			}
			logPolygonDebug("polygon_rpc_transport_error", url, e?.message || e);
		}
	}

	return null;
}

// Global request counters for external scanner calls
let polygonscanRequestsGlobal = 0;
const polygonscanRequestBreakdown = { verification: 0, tokenBalance: 0, tx: 0 };

const {
	COMMON_TOKENS_POLYGON,
	COMMON_TOKEN_ID_BY_ADDRESS_POLYGON,
	COMMON_TOKEN_DECIMALS_BY_ADDRESS_POLYGON,
	COMMON_TOKEN_METADATA_BY_ADDRESS_POLYGON,
	isCommonPolygonToken,
	USDC_BRIDGED,
	USDC_NATIVE,
} = require("./polygon-tokens.constants");

const {
	buildPolygonPortfolioToken,
	prioritizeAndCapCuratedMissingForRpc,
	formatBlockscoutErc20ItemsForPortfolio,
} = require("./polygon-portfolio-tokens.helpers");

async function getCoinGeckoPricesForPolygonContracts(contractAddresses) {
	try {
		if (!Array.isArray(contractAddresses) || contractAddresses.length === 0) return new Map();

		const unique = Array.from(new Set(contractAddresses.map((a) => (a || "").toLowerCase()))).filter(Boolean);
		const chunkSize = 100;
		const priceMap = new Map();

		for (let i = 0; i < unique.length; i += chunkSize) {
			const chunk = unique.slice(i, i + chunkSize);
			const url = `https://api.coingecko.com/api/v3/simple/token_price/polygon-pos?contract_addresses=${chunk.join(",")}&vs_currencies=usd`;
			const { data } = await instance.get(url);

			Object.entries(data || {}).forEach(([addr, value]) => {
				const usd = value && typeof value.usd === "number" ? value.usd : 0;

				if (!usd) return;

				priceMap.set(addr.toLowerCase(), usd);
			});
		}

		return priceMap;
	} catch (error) {
		console.error({ coingecko_polygon_error: error?.message || error });

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
		console.error({ coingecko_id_error: error?.message || error });

		return new Map();
	}
}

// Polygonscan verification (similar to BscScan)
async function getPolygonscanVerifiedContracts(contractAddresses) {
	try {
		if (!polygonscanApiKey) return new Set();

		const unique = Array.from(new Set((contractAddresses || []).map((a) => (a || "").toLowerCase()))).filter(Boolean);
		const concurrency = 3; // reduce concurrency to ease rate limits
		const verified = new Set();

		for (let i = 0; i < unique.length; i += concurrency) {
			const batch = unique.slice(i, i + concurrency);

			const results = await Promise.all(
				batch.map(async (address) => {
					// Try cache first
					try {
						const cached = await getVerification(POLYGON_CHAIN_ID, address);

						if (cached && typeof cached.isVerified === "boolean") {
							if (cached.isVerified) return address;

							return null;
						}
					} catch (_) { }

					try {
						const url = `${polygonscanApiUrl}?chainid=${POLYGON_CHAIN_ID}&module=contract&action=getsourcecode&address=${address}&apikey=${polygonscanApiKey}`;

						polygonscanRequestsGlobal++;
						polygonscanRequestBreakdown.verification++;

						const { data } = await instance.get(url);
						const item = Array.isArray(data?.result) ? data.result[0] : undefined;
						const abi = item?.ABI;

						if (abi && typeof abi === "string" && abi !== "Contract source code not verified") {
							await setVerification(POLYGON_CHAIN_ID, address, true, "etherscan");

							return address;
						}

						await setVerification(POLYGON_CHAIN_ID, address, false, "etherscan");
					} catch (err) {
						// skip individual errors
					}

					return null;
				})
			);

			results.filter(Boolean).forEach((addr) => verified.add(addr));

			// space batches
			if (i + concurrency < unique.length) await sleep(POLYGONSCAN_BATCH_DELAY_MS);
		}

		return verified;
	} catch (error) {
		console.error({ polygonscan_verification_error: error?.message || error });

		return new Set();
	}
}

// Minimal JSON-RPC call to fetch ERC-20 balance via balanceOf(address) using only the configured RPC
async function getErc20BalanceViaRpc(contractAddress, userAddress) {
	try {
		const methodId = "0x70a08231"; // balanceOf(address)
		const addressHex = String(userAddress).toLowerCase().replace(/^0x/, "");
		const data = methodId + "000000000000000000000000" + addressHex;

		const payload = {
			jsonrpc: "2.0",
			id: 0,
			method: "eth_call",
			params: [
				{
					to: contractAddress,
					data,
				},
				"latest",
			],
		};

		const rpc = await postPolygonRpc(payload);
		const hex = rpc?.result || "0x0";

		return hex === "0x" ? "0x0" : hex;
	} catch (error) {
		logPolygonDebug("rpc_balance_error", polygonRpcUrl || "naas_polygon_fallback", contractAddress, error?.message || error);

		return "0x0";
	}
}

// Batch ERC-20 balances via eth_call (multicall style without onchain Multicall)
async function getErc20BalancesViaRpcBatch(contracts, userAddress) {
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
		const results = await Promise.all(calls.map((payload) => postPolygonRpc(payload).catch(() => null)));

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

		const rpc = await postPolygonRpc(payload);
		if (!rpc?.result) return 0;

		const hex = rpc.result || "0x0";
		const wei = hex && typeof hex === "string" && hex.startsWith("0x") ? parseInt(hex, 16) : Number(hex || 0);

		return Number(wei);
	} catch (error) {
		logPolygonDebug("rpc_native_balance_error", userAddress, error?.message || error);

		return 0;
	}
}

// Fetch transactions via OKLink
async function getOklinkTransactions(address, page, show, price) {
	try {
		const t = Date.now();
		const url = `https://www.oklink.com/api/explorer/v2/polygon/addresses/${address}/transactionsByClassfy/condition?offset=${page}&limit=${show}&address=${address}&nonzeroValue=false&t=${t}`;

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
					age: tx.blocktime ? moment(tx.blocktime * 1000).fromNow() : "",
					amount: value ? String(value) : "0",
					asset: "POL",
					block: String(tx.blockHeight || ""),
					date: tx.blocktime ? moment(tx.blocktime * 1000).format("YYYY-MM-DD HH:mm:ss") : "",
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
		logPolygonDebug("oklink_tx_error", error?.message || error);

		return null;
	}
}

// Fetch transactions via Polygonscan
async function getPolygonscanTransactions(address, page, show, price) {
	try {
		const apikey = polygonscanApiKey ? `&apikey=${polygonscanApiKey}` : "";
		const url = `${polygonscanApiUrl}?chainid=${POLYGON_CHAIN_ID}&module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=${page}&offset=${show}&sort=desc${apikey}`;
		const { data } = await instance.get(url);

		polygonscanRequestsGlobal++;
		polygonscanRequestBreakdown.tx++;

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
					age: tx.timeStamp ? moment(Number(tx.timeStamp) * 1000).fromNow() : "",
					amount: value ? String(value) : "0",
					asset: "POL",
					block: String(tx.blockNumber || ""),
					date: tx.timeStamp ? moment(Number(tx.timeStamp) * 1000).format("YYYY-MM-DD HH:mm:ss") : "",
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
		logPolygonDebug("polygonscan_tx_error", error?.message || error);

		return null;
	}
}

// OKLink fallback: fetch ERC-20 token holdings for Polygon
async function getOklinkFormattedTokens(address, limit = 100) {
	try {
		const t = Date.now();
		const url = `https://www.oklink.com/api/explorer/v2/polygon/addresses/${address}/tokens?offset=0&limit=${limit}&t=${t}`;

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
				const addr = String(tok.contractAddress || "");

				if (!addr) return null;

				const decimals = parseInt(tok.decimals || 18);
				const rawAmount = Number(tok.holdingAmount || 0);
				const amount = rawAmount / Math.pow(10, decimals);

				let price = Number(tok.price || 0);

				if ((!price || price === 0) && (addr.toLowerCase() === USDC_BRIDGED || addr.toLowerCase() === USDC_NATIVE)) {
					price = 1;
				}

				const fiatBalance = amount * price;
				const meta = COMMON_TOKEN_METADATA_BY_ADDRESS_POLYGON.get(addr.toLowerCase()) || {};

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
					tokenType: "ERC-20",
				};
			})
			.filter(Boolean)
			.sort((a, b) => Number(b.fiatBalance) - Number(a.fiatBalance));

		return formatted;
	} catch (error) {
		logPolygonDebug("oklink_tokens_error", error?.message || error);

		return [];
	}
}

/**
 * @param {*} params
 */
const getBalance = async (params) => {
	try {
		const address = params.id;

		// Resolve/normalize address even if Blockscout is down
		let formatedAddress = String(address).toLowerCase();
		let blockscoutUp = true;

		try {
			const checkRedirect = await instance.get(`https://polygon.blockscout.com/api/v2/search/check-redirect?q=${address}`, {
				headers: {
					"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
					"Upgrade-Insecure-Requests": "1",
				},
			});

			formatedAddress = checkRedirect?.data?.parameter || formatedAddress;
		} catch (_) {
			blockscoutUp = false;

			logPolygonDebug("blockscout_check_redirect_down_using_fallback", formatedAddress);
		}

		logPolygonDebug("formattedAddress", formatedAddress);

		let data = {};

		try {
			const resp = await instance.get(`https://polygon.blockscout.com/api/v2/addresses/${formatedAddress}`, {
				headers: {
					"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
					"Upgrade-Insecure-Requests": "1",
				},
			});

			data = resp?.data || {};
		} catch (_) {
			blockscoutUp = false;

			logPolygonDebug("blockscout_address_down_using_rpc_for_native");
		}

		const { price: price } = await getTickerPrice({ symbol: "POL" });

		let erc20Items = [];

		try {
			const tokensResponse = await instance.get(`https://polygon.blockscout.com/api/v2/addresses/${formatedAddress}/tokens?type=ERC-20`);

			erc20Items = Array.isArray(tokensResponse?.data?.items) ? tokensResponse.data.items : [];
		} catch (_) {
			blockscoutUp = false;

			logPolygonDebug("blockscout_tokens_down_try_oklink");
		}
		const contractAddresses = erc20Items.map((item) => item?.token?.address).filter(Boolean);

		logPolygonDebug("erc20ItemsCount", erc20Items.length);

		logPolygonDebug(
			"firstTokenAddresses",
			erc20Items.slice(0, 10).map((it) => String(it?.token?.address || "").toLowerCase())
		);

		logPolygonDebug("polygonscanApiCfg", {
			url: polygonscanApiUrl,
			keyPresent: Boolean(polygonscanApiKey),
		});

		logPolygonDebug("blockscoutHasUSDC", {
			bridged: erc20Items.some((it) => String(it?.token?.address || "").toLowerCase() === USDC_BRIDGED),
			native: erc20Items.some((it) => String(it?.token?.address || "").toLowerCase() === USDC_NATIVE),
		});

		// Fetch CoinGecko prices by contract for Polygon
		const coingeckoPriceMap = await getCoinGeckoPricesForPolygonContracts(contractAddresses);

		logPolygonDebug("coingeckoPriceMap", coingeckoPriceMap.size, {
			bridged: coingeckoPriceMap.has(USDC_BRIDGED),
			native: coingeckoPriceMap.has(USDC_NATIVE),
		});

		// Polygonscan verification
		const verifiedSet = await getPolygonscanVerifiedContracts(contractAddresses);

		logPolygonDebug("polygonscanVerifiedCount", verifiedSet.size);

		let tokens = [];

		if (erc20Items.length > 0) {
			tokens = formatBlockscoutErc20ItemsForPortfolio(erc20Items, coingeckoPriceMap, verifiedSet);
		}

		logPolygonDebug(
			"formattedTokensCount",
			tokens.length,
			tokens.slice(0, 10).map((t) => String(t.address || "").toLowerCase())
		);

		// Force-include curated tokens if Blockscout returned them but filters excluded them (e.g., price glitches)
		const included = new Set(tokens.map((t) => (t.address || "").toLowerCase()));
		const erc20ByAddress = new Map(erc20Items.map((it) => [String(it?.token?.address || "").toLowerCase(), it]).filter(([addr]) => !!addr));

		const curatedPresentInItems = contractAddresses
			.map((a) => (a || "").toLowerCase())
			.filter((a) => isCommonPolygonToken(a) && !included.has(a));

		logPolygonDebug("curatedPresentInItems", curatedPresentInItems);

		let forcedFromItems = 0;

		for (const addr of curatedPresentInItems) {
			const item = erc20ByAddress.get(addr);

			if (!item) continue;

			const token = item.token || {};
			const decimals = parseInt(token.decimals || COMMON_TOKEN_DECIMALS_BY_ADDRESS_POLYGON.get(addr) || 18);
			const rawAmount = item.value || 0;
			const amount = Number(rawAmount) / Math.pow(10, decimals);
			const cgPrice = coingeckoPriceMap.get(addr) || 0;
			const price = cgPrice || Number(token.exchange_rate || 0) || 0;

			tokens.push(
				buildPolygonPortfolioToken({
					address: token.address,
					amount,
					decimals,
					price,
					image: token.icon_url || "",
					name: token.name || "",
					symbol: token.symbol || "",
					tokenType: token.type || "ERC-20",
				})
			);

			forcedFromItems++;
		}

		logPolygonDebug("forcedFromItems", forcedFromItems);

		// Resolve native POL balance early so we can skip the curated RPC fallback for unfunded addresses.
		const maticDecimals = 18;
		let nativeRaw = Number(data?.coin_balance || 0);

		if (!nativeRaw) nativeRaw = await getNativeBalanceViaRpc(formatedAddress);

		logPolygonDebug("nativeRaw", nativeRaw);

		// Curated tokens not present in Blockscout items → fetch balances via QuickNode RPC batch only
		const curatedUniverse = Array.from(COMMON_TOKENS_POLYGON).map((a) => a.toLowerCase());

		const curatedMissingRaw = curatedUniverse.filter((a) => !erc20ByAddress.has(a));
		// When Blockscout was up, we previously issued one eth_call per curated token missing from the explorer list (~20+ per address).
		const curatedMissingFromItems = prioritizeAndCapCuratedMissingForRpc(
			curatedMissingRaw,
			CURATED_RPC_FALLBACK_MAX,
			!blockscoutUp
		);

		logPolygonDebug("curated_rpc_after_cap", {
			rawMissing: curatedMissingRaw.length,
			capped: curatedMissingFromItems.length,
			blockscoutUp,
			skippedDueToZeroNative: nativeRaw === 0,
		});

		if (curatedMissingFromItems.length > 0 && nativeRaw > 0) {
			const rpcBalances = await getErc20BalancesViaRpcBatch(curatedMissingFromItems, formatedAddress);
			const added = [];

			for (const contract of curatedMissingFromItems) {
				const raw = rpcBalances.get(contract) || "0x0";
				const numericRaw = typeof raw === "string" && raw.startsWith("0x") ? parseInt(raw, 16) : Number(raw);

				if (!numericRaw) continue;

				const decimals = COMMON_TOKEN_DECIMALS_BY_ADDRESS_POLYGON.get(contract) || 18;
				const amount = Number(numericRaw) / Math.pow(10, decimals);

				if (amount <= 0) continue;

				const id = COMMON_TOKEN_ID_BY_ADDRESS_POLYGON.get(contract);

				let price = 0;

				if (id) {
					const idPrices = await getCoinGeckoPricesForIds([id]);

					price = idPrices.get(id) || 0;
				}

				tokens.push(
					buildPolygonPortfolioToken({
						address: contract,
						amount,
						decimals,
						price,
					})
				);

				added.push(contract);
			}

			logPolygonDebug("rpcFallbackAdded", added.length, added);
		}

		// De-duplicate and sort again
		const seen = new Set();

		tokens = tokens
			.filter((token) => {
				const key = (token.address || "").toLowerCase();

				if (seen.has(key)) return false;

				seen.add(key);

				return true;
			})
			.sort((a, b) => Number(b.fiatBalance) - Number(a.fiatBalance));

		logPolygonDebug("finalTokensCount", tokens.length, {
			hasUSDCBridged: tokens.some((t) => String(t.address || "").toLowerCase() === USDC_BRIDGED),
			hasUSDCNative: tokens.some((t) => String(t.address || "").toLowerCase() === USDC_NATIVE),
		});

		const transactions = await getTransactionsList({ id: address }, { show: 10 });

		// nativeRaw was resolved earlier (before curated RPC fallback) to avoid redundant requests.
		const maticAmount = Number(nativeRaw) / Math.pow(10, maticDecimals);
		const maticFiatBalance = maticAmount * price;

		logPolygonDebug("polygonscanRequests", polygonscanRequestsGlobal, polygonscanRequestBreakdown);

		const response = {
			address,
			balance: maticAmount.toFixed(maticDecimals),
			fiatBalance: maticFiatBalance,
			type: "system_account",
			account: {
				asset: "POL",
				fiatBalance: maticFiatBalance,
				price: price,
			},
			tokenHoldings: {
				total: 1 + tokens.length,
				balance: Number((maticFiatBalance + tokens.reduce((s, t) => s + Number(t.fiatBalance || 0), 0)).toFixed(8)),
				tokens: [
					{
						tokenType: "MATIC",
						fiatBalance: maticFiatBalance,
						symbol: "POL",
						name: "Polygon",
						price: price,
						image: "https://s2.coinmarketcap.com/static/img/coins/64x64/28321.png",
						amount: maticAmount.toFixed(maticDecimals),
						decimals: maticDecimals,
					},
					...tokens,
				],
			},
			transactions: transactions.transactions,
		};

		return response;
	} catch (error) {
		console.error({ error });
	}
};

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

		const lowPriorityAndBase = $("#spanDynamicLowPriorityAndBase").text().trim();

		let lowTime = $("#divLowPrice > div.text-muted")
			.first()
			.text()
			.replace(/^\(([^)]+)\).*$/, "$1")
			.trim();

		const priceInDollars = $("div.text-muted")
			.text()
			.match(/\$\d+\.\d+/)[0];

		const lowNumbers = lowPriorityAndBase.match(/\d+(\.\d+)?/g);
		const lowBase = parseFloat(lowNumbers[0]).toString();
		const lowPriority = parseFloat(lowNumbers[1]).toString();

		const avgPriorityAndBase = $("#spanDynamicProposePriorityAndBase").text().trim();
		const avgPriceInDollars = $("div.text-muted")
			.text()
			.match(/\$\d+\.\d+/)[0];

		let averageTime = $("#divAvgPrice > div.text-muted")
			.text()
			.replace(/^\(([^)]+)\).*$/, "$1")
			.trim();

		const avgNumbers = avgPriorityAndBase.match(/\d+(\.\d+)?/g);
		const avgBase = parseFloat(avgNumbers[0]).toString();
		const avgPriority = parseFloat(avgNumbers[1]).toString();

		const highPriorityAndBase = $("#spanDynamicHighPriorityAndBase").text().trim();
		const highPriceInDollars = $("div.text-muted")
			.text()
			.match(/\$\d+\.\d+/)[0];

		let highTime = $("#divHighPrice > div.text-muted")
			.text()
			.replace(/^\(([^)]+)\).*$/, "$1")
			.trim();

		const highNumbers = highPriorityAndBase.match(/\d+(\.\d+)?/g);
		const highBase = parseFloat(highNumbers[0]).toString();
		const highPriority = parseFloat(highNumbers[1]).toString();

		const featuredActions = [];

		const timeRegexp = /\(([^)]+)\)/;

		lowTime = `${lowTime.match(timeRegexp)?.[1]}`?.trim();
		averageTime = `${averageTime.match(timeRegexp)?.[1]}`?.trim();
		highTime = `${highTime.match(timeRegexp)?.[1]}`?.trim();

		$("#content > section.container-xxl.pb-16 > div.row.g-4.mb-4 > div:nth-child(2) > div > div > div:nth-child(2) > div > table tr").each(
			(index, element) => {
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

		// Formar el objeto de respuesta final.
		const response = {
			low: {
				base: lowBase,
				cost: priceInDollars,
				gwei: lowGwei,
				priority: lowPriority,
				time: lowTime,
			},
			average: {
				base: avgBase,
				cost: avgPriceInDollars,
				gwei: averageGwei,
				priority: avgPriority,
				time: averageTime,
			},
			high: {
				base: highBase,
				cost: highPriceInDollars,
				gwei: highGwei,
				priority: highPriority,
				time: highTime,
			},
			featuredActions,
		};

		return response;
	} catch (error) {
		console.error({ error: error });
	}
};

/* ------------------------------------------------------------------------- *
 * Polygon transaction status (GET /api/polygon/transaction/:id)
 *
 * Design contract:
 *   - Each HTTP call performs ONE fast upstream attempt (no retry loop, no
 *     sleep, no inter-source fallback in the same request).
 *   - The client (extension) polls this endpoint on a short interval and
 *     rotates `?source=rpc|bogota` until a real payload comes back, keeping
 *     individual requests short and the server unblocked.
 * ------------------------------------------------------------------------- */

const isBogotaPolygonTxEmpty = (inner) => inner == null || (Array.isArray(inner) && inner.length === 0);

const weiHexToPolString = (weiHex) => {
	try {
		return (Number(BigInt(weiHex || "0x0")) / 1e18).toString();
	} catch (_) {
		return "0";
	}
};

/**
 * Build a minimal tx detail from chain RPC. `eth_getTransactionReceipt` and
 * `eth_getTransactionByHash` are independent reads, so we issue them in
 * parallel to keep a single backend request fast.
 * @param {string} txHash
 */
const buildPolygonTransactionFromRpc = async (txHash) => {
	if (!txHash || typeof txHash !== "string" || !txHash.startsWith("0x")) return null;

	const [receiptRes, txRes] = await Promise.all([
		postPolygonRpc({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash] }),
		postPolygonRpc({ jsonrpc: "2.0", id: 2, method: "eth_getTransactionByHash", params: [txHash] }),
	]);

	const receipt = receiptRes && receiptRes.result;
	const tx = txRes && txRes.result;
	if (!receipt || !tx) return null;

	const blockNum = receipt.blockNumber ? parseInt(String(receipt.blockNumber), 16) : 0;
	const gasUsed = BigInt(receipt.gasUsed || "0x0");
	const effPrice = BigInt(receipt.effectiveGasPrice || receipt.gasPrice || "0x0");
	const feeWei = gasUsed * effPrice;
	const isContractCall = tx.input && tx.input !== "0x" && String(tx.input).length > 2;

	return {
		id: txHash,
		hash: txHash,
		from: tx.from || "",
		to: tx.to || "",
		block: String(blockNum),
		status: receipt.status === "0x1" ? "Success" : "Failed",
		amount: weiHexToPolString(tx.value || "0x0"),
		symbol: "POL",
		network: "polygon",
		date: new Date().toISOString().slice(0, 10),
		timestamp: String(Math.floor(Date.now() / 1000)),
		transactionFee: (Number(feeWei) / 1e18).toString(),
		transactionFeeFiat: "0",
		fiatAmount: 0,
		gasPrice: "",
		gwei: "",
		age: "",
		observation: "",
		image: "",
		transactionType: isContractCall ? "call" : "transfer",
		tokensTransferred: [],
	};
};

const fetchPolygonTxFromBogota = async (id) => {
	if (!urlBase || !token) return null;
	try {
		const res = await instance.get(`${urlBase}/api/evm-tx/polygon-transaction?address=${id}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		const inner = res && res.data && res.data.data;
		return isBogotaPolygonTxEmpty(inner) ? null : inner;
	} catch (e) {
		logPolygonDebug("polygon_tx_bogota_error", e?.message || e);
		return null;
	}
};

/**
 * @param {Object} params  route params (`id` = tx hash)
 * @param {Object} [query] query params (`source` = "rpc" | "bogota"; default "rpc")
 * @returns the upstream payload, or `[]` when the chosen source has no data yet
 */
const getTransactionStatus = async (params, query = {}) => {
	const id = params.id;
	const source = String(query.source || "rpc").toLowerCase() === "bogota" ? "bogota" : "rpc";

	try {
		const result = source === "bogota" ? await fetchPolygonTxFromBogota(id) : await buildPolygonTransactionFromRpc(id);
		return result || [];
	} catch (e) {
		logPolygonDebug("polygon_tx_status_error", source, e?.message || e);
		return [];
	}
};

async function getBlockscoutPolygonTransactions(address, page, show, price) {
	try {
		const pageNumber = Math.max(0, parseInt(page, 10) || 0);
		const limit = Math.max(1, parseInt(show, 10) || 10);
		const { data } = await instance.get(`https://polygon.blockscout.com/api/v2/addresses/${address}/transactions`);
		const items = Array.isArray(data?.items) ? data.items : [];
		const slice = items.slice(pageNumber * limit, (pageNumber + 1) * limit);
		const transactions = slice.map((tx) => {
			const value = Number(tx.value || 0) / 1e18;
			const fiatValue = value * Number(price || 0);
			const from = tx.from?.hash || tx.from || "";
			const to = tx.to?.hash || tx.to || "";
			const traffic = String(from).toLowerCase() === String(address).toLowerCase() ? "OUT" : "IN";
			let txnFee = "0";
			if (tx.fee?.value != null) txnFee = String(Number(tx.fee.value) / 1e18);
			const timestamp = tx.timestamp ? new Date(tx.timestamp) : null;
			const unix = timestamp && !Number.isNaN(timestamp.getTime()) ? Math.floor(timestamp.getTime() / 1000) : 0;

			return {
				age: unix ? moment(unix * 1000).fromNow() : "",
				amount: value ? String(value) : "0",
				asset: "POL",
				block: String(tx.block_number || tx.block || ""),
				date: unix ? moment(unix * 1000).format("YYYY-MM-DD HH:mm:ss") : "",
				fiatAmount: fiatValue.toFixed(2),
				from,
				hash: tx.hash,
				method: tx.method || (tx.raw_input && tx.raw_input !== "0x" ? "Contract Interaction" : "Transfer"),
				to,
				traffic,
				txnFee,
			};
		});

		return { pagination: { records: String(transactions.length), pages: "1", page: String(page) }, transactions };
	} catch (error) {
		logPolygonDebug("blockscout_tx_error", error?.message || error);
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
		// Get current POL price for fiat calculation
		let price = 0;
		try {
			const p = await getTickerPrice({ symbol: "POL" });
			price = Number(p?.price || 0);
		} catch (_) { }

		const scanPage = String(page) === "0" ? 1 : page;
		let resp = await getPolygonscanTransactions(address, scanPage, show, price);
		if (resp && resp.transactions && resp.transactions.length > 0) return resp;

		resp = await getBlockscoutPolygonTransactions(address, page, show, price);
		if (resp && resp.transactions && resp.transactions.length > 0) return resp;

		// Final fallback: internal microservice (if configured)
		try {
			const { data } = await instance.get(`${urlBase}/api/evm-tx/polygon-transactions?address=${address}&show=${show}`, {
				headers: token ? { Authorization: `Bearer ${token}` } : {},
			});
			return { pagination: { records: String(data?.length || 0), pages: "1", page: String(page) }, transactions: data || [] };
		} catch (_) { }

		return { pagination: { records: "0", pages: "0", page: String(page) }, transactions: [] };
	} catch (error) {
		console.error({ error });
		return { pagination: { records: "0", pages: "0", page: String(page) }, transactions: [] };
	}
};

module.exports = {
	getBalance,
	getGasTracker,
	getTransactionsList,
	getTransactionStatus,
};
