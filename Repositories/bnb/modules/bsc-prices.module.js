// Batched, cached USD prices for BSC balances.
// One ticker request covers every token (Binance.US full ticker list, Binance.com as fallback); CoinGecko (one batched
// call) only for tokens without a Binance pair. The ticker list is cached for BSC_PRICE_TTL_MS (60 s) and the last good
// price per key is kept for BSC_PRICE_MAX_STALE_MS (30 min), so a rate-limited/failed refresh never turns a price into 0.
// (Before: a CoinGecko 429/400 dropped prices to 0, which made totals swing from ~$1,864 to ~$120 between two calls.)

const { getCleanInstance } = require("../../../Core/axios");

const PRICE_TTL_MS = Number(process.env.BSC_PRICE_TTL_MS || 60000);
const PRICE_MAX_STALE_MS = Number(process.env.BSC_PRICE_MAX_STALE_MS || 30 * 60000);
const PRICE_TIMEOUT_MS = Number(process.env.BSC_PRICE_TIMEOUT_MS || 2500);

const TICKER_SOURCES = ["https://api.binance.us/api/v3/ticker/price", "https://api.binance.com/api/v3/ticker/price"];
const COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price";

const instance = getCleanInstance(PRICE_TIMEOUT_MS);

const state = {
	tickers: new Map(), // "BNBUSDT" -> price
	tickersAt: 0,
	tickersInflight: null,
	cg: new Map(), // coingecko id -> { price, at }
	cgInflight: new Map(), // ids key -> Promise
	lastGood: new Map(), // price key -> { price, at }
};

/** Price key for a token definition: "S:<binance base symbol>" or "CG:<coingecko id>". */
const priceKeyOf = (token) => (token.priceSymbol ? `S:${token.priceSymbol}` : token.coingeckoId ? `CG:${token.coingeckoId}` : null);

/** CoinGecko key used when the Binance pair is missing (tokens may define both priceSymbol and coingeckoId). */
const fallbackKeyOf = (token) => (token.priceSymbol && token.coingeckoId ? `CG:${token.coingeckoId}` : null);

const fetchTickers = async () => {
	for (const url of TICKER_SOURCES) {
		try {
			const { data } = await instance.get(url, { timeout: PRICE_TIMEOUT_MS });

			if (!Array.isArray(data) || !data.length) continue;

			const map = new Map();

			for (const row of data) {
				const price = Number(row?.price);

				if (row?.symbol && price > 0) map.set(row.symbol, price);
			}

			if (map.size) return map;
		} catch (_) {}
	}

	return null;
};

/** Refresh the full ticker list at most once per TTL; concurrent callers share one request. */
const ensureTickers = async () => {
	if (state.tickersAt && Date.now() - state.tickersAt <= PRICE_TTL_MS) return;

	if (!state.tickersInflight) {
		state.tickersInflight = fetchTickers()
			.then((map) => {
				if (map) {
					state.tickers = map;
					state.tickersAt = Date.now();
				}
			})
			.finally(() => {
				state.tickersInflight = null;
			});
	}

	await state.tickersInflight;
};

const ensureCoinGecko = async (ids) => {
	const now = Date.now();
	const missing = [...new Set(ids)].filter((id) => !(state.cg.get(id) && now - state.cg.get(id).at <= PRICE_TTL_MS)).sort();

	if (!missing.length) return;

	const key = missing.join(",");

	if (!state.cgInflight.has(key)) {
		const p = instance
			.get(`${COINGECKO_URL}?ids=${key}&vs_currencies=usd`, { timeout: PRICE_TIMEOUT_MS })
			.then(({ data }) => {
				const at = Date.now();

				for (const id of missing) {
					const usd = Number(data?.[id]?.usd);

					// Mark every attempted id (0 = no price) so a missing id doesn't re-trigger a request on every call.
					state.cg.set(id, { price: usd > 0 ? usd : 0, at });
				}
			})
			.catch(() => {})
			.finally(() => state.cgInflight.delete(key));

		state.cgInflight.set(key, p);
	}

	await state.cgInflight.get(key);
};

/** Current price for a key from the caches (0 when unknown). */
const currentPrice = (key) => {
	if (key.startsWith("S:")) {
		const sym = key.slice(2);

		return state.tickers.get(`${sym}USDT`) || state.tickers.get(`${sym}USD`) || 0;
	}

	return state.cg.get(key.slice(3))?.price || 0;
};

/**
 * USD prices for the given token definitions, keyed by price key ("S:BNB", "CG:venus", ...).
 * Fresh value → last good value (<= MAX_STALE) → 0.
 * @param {Array<{priceSymbol?: string, coingeckoId?: string}>} tokens
 * @returns {Promise<Map<string, number>>}
 */
const getPrices = async (tokens) => {
	await ensureTickers();

	const cgIds = [];

	for (const t of tokens) {
		const key = priceKeyOf(t);

		if (!key) continue;

		if (key.startsWith("CG:")) cgIds.push(t.coingeckoId);
		else if (fallbackKeyOf(t) && !currentPrice(key)) cgIds.push(t.coingeckoId);
	}

	if (cgIds.length) await ensureCoinGecko(cgIds);

	const now = Date.now();
	const prices = new Map();

	for (const key of new Set(tokens.flatMap((t) => [priceKeyOf(t), fallbackKeyOf(t)]).filter(Boolean))) {
		const price = currentPrice(key);

		if (price > 0) {
			state.lastGood.set(key, { price, at: now });
			prices.set(key, price);
		} else {
			const lastGood = state.lastGood.get(key);

			prices.set(key, lastGood && now - lastGood.at <= PRICE_MAX_STALE_MS ? lastGood.price : 0);
		}
	}

	return prices;
};

/** Final USD price for a token definition. Stablecoins: market price when sane (0.9–1.1), else the 1.00 peg. */
const priceForToken = (token, prices) => {
	const price = prices.get(priceKeyOf(token)) || prices.get(fallbackKeyOf(token)) || 0;

	if (token.stable) return price >= 0.9 && price <= 1.1 ? price : 1;

	return price;
};

/** Test helper: reset the in-memory caches. */
const _resetPriceCache = () => {
	state.tickers = new Map();
	state.tickersAt = 0;
	state.tickersInflight = null;
	state.cg.clear();
	state.cgInflight.clear();
	state.lastGood.clear();
};

module.exports = { getPrices, priceForToken, priceKeyOf, _resetPriceCache, PRICE_TTL_MS, PRICE_MAX_STALE_MS };
