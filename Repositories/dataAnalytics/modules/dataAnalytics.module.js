const { getCleanInstance } = require("../../../Core/axios");
const instance = getCleanInstance(30000);
const Model = require("../models/dataAnalytics.model");
const moment = require("moment");
const axios = require("axios");
const { isUnsupportedChain, unsupportedChainError } = require("../../../Core/unsupported-networks");

let _binanceInstance = null;

/**
 * @param {*} params
 */
const getAssetDetails = async (params) => {
	try {
		if (isUnsupportedChain(params.asset)) throw unsupportedChainError();
		const { symbol, network, idAseet } = await idAseet_(params.asset);

		const statistics = await instance.get(
			`https://api.coinmarketcap.com/aggr/v3.1/mobile/coin-detail?id=${idAseet}&langCode=${params.langCode}&convertId=5426`,
			{
				headers: {
					"user-agent": "Dart/3.2 (dart:io)",
					appversion: "4.63.1",
					platform: "android",
				},
			}
		);

		delete statistics.data.data.urls.message_board;
		delete statistics.data.data.urls.announcement;

		const response = {
			price: {
				price: statistics.data.data.statistics.price,
				priceChangePercentage1h:
					statistics.data.data.statistics.priceChangePercentage1h,
				priceChangePercentage1y:
					statistics.data.data.statistics.priceChangePercentage1y,
				priceChangePercentage24h:
					statistics.data.data.statistics.priceChangePercentage24h,
				priceChangePercentage30d:
					statistics.data.data.statistics.priceChangePercentage30d,
				priceChangePercentage60d:
					statistics.data.data.statistics.priceChangePercentage60d,
				priceChangePercentage7d:
					statistics.data.data.statistics.priceChangePercentage7d,
				priceChangePercentage90d:
					statistics.data.data.statistics.priceChangePercentage90d,
				priceChangePercentageAll:
					statistics.data.data.statistics.priceChangePercentageAll,
				priceChangePercentageYesterday:
					statistics.data.data.statistics.priceChangePercentageYesterday,
			},
			about: {
				symbol: symbol,
				network: network,
				description: statistics.data.data.description,
				urls: statistics.data.data.urls,
				information: {
					marketCap: statistics.data.data.statistics.marketCap,
					marketCapChangePercentage24h:
						statistics.data.data.statistics.marketCapChangePercentage24h,
					volume: statistics.data.data.volume,
					volumeChangePercentage24h:
						statistics.data.data.volumeChangePercentage24h,
					totalSupply: statistics.data.data.statistics.totalSupply,
					circulatingSupply: statistics.data.data.statistics.circulatingSupply,
					holders:
						statistics.data?.data?.analysisV2?.addressByTimeHeld
							?.holdersPercent,
				},
				performance24h: {
					volume: statistics.data.data.statistics.volumeYesterday,
					volumePriceChangePercentage:
						statistics.data.data.statistics.ytdPriceChangePercentage,
					traders:
						statistics.data?.data?.analysisV2?.addressByTimeHeld
							?.tradersPercent,
				},
			},
		};

		try {
			response.chart = await getChart({
				asset: symbol,
				interval: params.interval || "1d",
				startDate: moment().subtract(1, "month").format("YYYY-MM-DD HH:mm:ss"),
				endDate: moment().format("YYYY-MM-DD HH:mm:ss"),
			});
		} catch (error) {
			response.chart = [];
		}

		return response;
	} catch (error) {
		error = new Error("asset_not_found");
		error.status = 404;
		throw error;
	}
};

const _getBinanceInstance = () => {
	if (_binanceInstance) {
		return _binanceInstance;
	}

	_binanceInstance = axios.create({
		baseURL: "https://api.binance.us/api",
		timeout: 15000,
	});

	_binanceInstance.defaults.headers.common["Content-Type"] = "application/json";

	return _binanceInstance;
};

/**
 * get K lines
 * @param {string} symbol
 * @param {string} interval
 * @param {number} limit
 * @author Miguel Trevino
 */
const getKLines = async (symbol = "BTCUSDT", interval = "1m", limit = 1000) => {
	const instance = _getBinanceInstance();

	const response = await instance.get(
		`/v3/klines?symbol=${symbol}&interval=${interval}&limit=${parseInt(limit)}`
	);

	return response.data ? response.data : [];
};

const _getExactLimit = (_startDate, interval) => {
	const now = moment();

	let limit = 0;

	switch (interval) {
		case "1d":
			limit = now.diff(_startDate, "days");
			break;

		case "6h":
			limit = now.diff(_startDate, "hours") / 6;

			break;
		case "4h":
			limit = now.diff(_startDate, "hours") / 4;

			break;

		case "1h":
			limit = now.diff(_startDate, "hours");

			break;
		default:
			break;
	}

	return limit;
};

const getChart = async (data) => {
	const { interval, limit, startDate, endDate } = data;

	let { asset } = data;
	let _limit = limit;
	let _endDate = null;
	let _startDate = null;

	if (startDate && endDate) {
		_startDate = moment(startDate).format("YYYY-MM-DD HH:mm:ss");
		_endDate =
			endDate === "now"
				? moment(new Date()).format("YYYY-MM-DD HH:mm:ss")
				: moment(endDate).format("YYYY-MM-DD HH:mm:ss");

		_limit = _getExactLimit(_startDate, interval);
	}

	if (isUnsupportedChain(asset)) throw unsupportedChainError();

	if (asset === "USDT") asset = "USDC";

	const klines = await getKLines(
		`${asset}USDT`,
		interval,
		_limit ? _limit : limit
	);
	const klinesMap = [];

	for (let index = 0; index < klines.length; index++) {
		const kline = klines[index];

		const dateTime = moment.unix(kline[0] / 1000);

		if (
			endDate &&
			startDate &&
			!dateTime.isBetween(_startDate, _endDate, "hours")
		)
			continue;
		if (endDate && dateTime.isAfter(_endDate, "days")) continue;
		if (startDate && dateTime.isBefore(_startDate, "days")) continue;

		klinesMap.push({
			index,
			time: kline[0] / 1000,
			open: parseFloat(kline[1]),
			high: parseFloat(kline[2]),
			low: parseFloat(kline[3]),
			close: parseFloat(kline[4]),
			dateTime: dateTime.format("YYYY-MM-DD HH:mm:ss"),
			type: kline[1] < kline[4] ? "uptrend" : "downtrend",
		});
	}

	return klinesMap;
};

// CoinMarketCap tiene mas de una moneda por simbolo, y la busqueda de abajo se queda
// con la primera que coincida. Para "TON" eso devolvia "TON Token" (id 6890, ~US$0.005)
// en lugar de la moneda de la red TON (id 11419), asi que el precio y el saldo en dolares
// de TON salian en practicamente cero en las apps. Estos ids se fijan a mano.
const ID_POR_SIMBOLO = {
	TON: { symbol: "TON", network: "Toncoin", idAseet: 11419 },
};

/** In-process symbol cache so concurrent formatters do not repeat Mongo/CMC work. */
const idAseetMemoryCache = new Map();
/** Single-flight map: one lookup per symbol while a prior request is still in flight. */
const idAseetInflight = new Map();
/** Only one CMC app-search download + Mongo upsert at a time. */
let cmcSearchDownloadPromise = null;

const formatCryptoData = (data) => {
	const { fields, values } = data;
	const ignoredFields = new Set(["type", "rank", "address", "search_score"]);

	return values.map((valueArray) => {
		const obj = {};
		fields.forEach((field, index) => {
			if (!ignoredFields.has(field)) {
				obj[field] = valueArray[index];
			}
		});
		return obj;
	});
};

const downloadCmcSearchIndex = async () => {
	if (!cmcSearchDownloadPromise) {
		cmcSearchDownloadPromise = instance
			.get("https://s3.coinmarketcap.com/generated/core/crypto/app-search.json", {
				headers: {
					"user-agent": "Dart/3.2 (dart:io)",
					appversion: "4.63.1",
					platform: "android",
				},
			})
			.then((cryptoResponse) => formatCryptoData(cryptoResponse.data))
			.finally(() => {
				cmcSearchDownloadPromise = null;
			});
	}

	return cmcSearchDownloadPromise;
};

const resolveIdAseetFromSources = async (asset) => {
	if (ID_POR_SIMBOLO[asset]) {
		return ID_POR_SIMBOLO[asset];
	}

	const cryptod = await Model.findOne({ "crypto.symbol": asset }, { "crypto.$": 1 });

	if (cryptod && cryptod.crypto.length > 0) {
		const { symbol, name: network, id: idAseet } = cryptod.crypto[0];
		return { symbol, network, idAseet };
	}

	const cryptoList = await downloadCmcSearchIndex();
	const result = cryptoList.find((token) => token.symbol === asset);

	if (!result) {
		const error = new Error("asset_not_found");
		error.status = 404;
		throw error;
	}

	await Model.findOneAndUpdate({}, { $set: { crypto: cryptoList } }, { new: true, upsert: true });

	return {
		symbol: result.symbol,
		network: result.name,
		idAseet: result.id,
	};
};

const idAseet_ = async (asset) => {
	if (idAseetMemoryCache.has(asset)) {
		return idAseetMemoryCache.get(asset);
	}

	if (idAseetInflight.has(asset)) {
		return idAseetInflight.get(asset);
	}

	const lookupPromise = resolveIdAseetFromSources(asset)
		.then((resolved) => {
			idAseetMemoryCache.set(asset, resolved);
			return resolved;
		})
		.finally(() => {
			idAseetInflight.delete(asset);
		});

	idAseetInflight.set(asset, lookupPromise);
	return lookupPromise;
};

module.exports = {
	getAssetDetails,
	getChart,
	idAseet_,
};
