const moment = require("moment");
const { tonApiGet, toTonUpstreamError } = require("./ton-api.client");
const { assertValidTonAddress, sameTonAddress } = require("./ton-address.util");
const { nanotonToTonString, jettonAmountToString } = require("./ton-jetton.util");
const { getTonUsdPrice, getJettonUsdRates, sumTokenFiatBalances, normalizeTokenKey } = require("./ton-price.util");

const TON_LOGO = "https://cdn.zelf.world/icons/ic_ton.png";

const encodeAccountId = (address) => encodeURIComponent(String(address || "").trim());

const buildNativeTonToken = (balanceTon, price, fiatBalance) => ({
	_fiatBalance: String(fiatBalance ?? 0),
	address_token: "TON",
	amount: String(balanceTon ?? "0"),
	fiatBalance: fiatBalance ?? 0,
	image: TON_LOGO,
	name: "Toncoin",
	price: price ?? "0",
	symbol: "TON",
	tokenType: "TON",
});

const mapJettonBalances = (balances = [], jettonRates = {}) =>
	balances.map((item) => {
		const jetton = item.jetton || {};
		const decimals = jetton.decimals ?? 9;
		const amount = jettonAmountToString(item.balance ?? 0, decimals);
		const symbol = jetton.symbol || "JETTON";
		const jettonAddress = normalizeTokenKey(jetton.address);
		const price = jettonRates[jettonAddress] ?? 0;
		const fiat = Number(amount) * Number(price);
		return {
			_fiatBalance: String(fiat || 0),
			address_token: jetton.address || "",
			amount,
			fiatBalance: fiat || 0,
			image: jetton.image || "",
			name: jetton.name || symbol,
			price: String(price),
			symbol,
			tokenType: symbol,
		};
	});

const mapEventsToTransactions = (events = [], address) =>
	events
		.map((event) => {
			const actions = event.actions || [];
			const tonTransfer = actions.find((a) => a.type === "TonTransfer" && a.TonTransfer);
			const jettonTransfer = actions.find((a) => a.type === "JettonTransfer" && a.JettonTransfer);
			const transfer = tonTransfer?.TonTransfer || jettonTransfer?.JettonTransfer;
			if (!transfer) return null;

			const from = transfer.sender?.address || "";
			const to = transfer.recipient?.address || "";
			const amountRaw = transfer.amount ?? 0;
			const amount =
				tonTransfer != null
					? nanotonToTonString(amountRaw)
					: jettonAmountToString(amountRaw, jettonTransfer?.JettonTransfer?.jetton?.decimals ?? 9);
			const asset = tonTransfer != null ? "TON" : jettonTransfer?.JettonTransfer?.jetton?.symbol || "JETTON";
			const ts = event.timestamp ? event.timestamp * 1000 : Date.now();
			const traffic = sameTonAddress(from, address) ? "OUT" : "IN";

			// TonAPI flags spam broadcasts and address-poisoning dust (`is_scam`). Incoming ones are
			// dropped, as the push watcher already does (TxNotifications/adapters/ton.adapter.js): a
			// 0.00001 TON spam that landed seconds after a send read as "Received" next to it (#556).
			// The account's own movements are never hidden.
			if (event.is_scam === true && traffic === "IN") return null;

			return {
				_amount: amount,
				_source: event,
				age: moment(ts).fromNow(),
				amount: Number(amount).toFixed(6),
				asset,
				block: String(event.lt || "0"),
				date: moment(ts).format("YYYY-MM-DD HH:mm:ss"),
				fiatBalance: 0,
				from,
				gas: "0",
				hash: event.event_id || "",
				method: tonTransfer ? "TonTransfer" : "JettonTransfer",
				timestamp: ts,
				to,
				traffic,
				txnFee: "0",
				status: event.in_progress ? "pending" : "success",
			};
		})
		.filter(Boolean)
		.sort((a, b) => b.timestamp - a.timestamp);

const getAddress = async (params) => {
	const address = assertValidTonAddress(params.id);
	let price = "0";

	try {
		price = await getTonUsdPrice();
	} catch (_) {
		/* price optional */
	}

	try {
		const account = await tonApiGet(`/accounts/${encodeAccountId(address)}`);
		const balanceTon = nanotonToTonString(account.balance ?? 0);
		const nativeFiatBalance = parseFloat((Number(balanceTon) * Number(price)).toFixed(4));

        let holdingsComplete = true;
        let historyComplete = true;
		let jettonBalances = [];
		try {
			const jettons = await tonApiGet(`/accounts/${encodeAccountId(address)}/jettons`);
			const rawBalances = jettons.balances || [];
			const jettonAddresses = rawBalances.map((item) => item.jetton?.address).filter(Boolean);
			const jettonRates = await getJettonUsdRates(jettonAddresses);
			jettonBalances = mapJettonBalances(rawBalances, jettonRates);
		} catch (error) {
            holdingsComplete = false;
			console.error("TON jettons fetch:", error.message);
		}

		let transactions = [];
		try {
			const events = await tonApiGet(`/accounts/${encodeAccountId(address)}/events`, { limit: 10 });
			transactions = mapEventsToTransactions(events.events || [], address);
		} catch (error) {
            historyComplete = false;
			console.error("TON events fetch:", error.message);
		}

		const tokens = [buildNativeTonToken(balanceTon, price, nativeFiatBalance), ...jettonBalances.filter((t) => t.symbol !== "TON")];
		const totalFiatBalance = sumTokenFiatBalances(tokens);

		return {
			_balance: balanceTon,
			_fiatBalance: String(totalFiatBalance),
			address,
			balance: balanceTon,
			fiatBalance: totalFiatBalance,
			account: {
				asset: "TON",
				fiatBalance: nativeFiatBalance,
				price,
			},
			tokenHoldings: {
				balance: String(totalFiatBalance),
				total: tokens.length,
				tokens,
			},
			transactions,
            historyComplete,
            holdingsComplete,
		};
	} catch (error) {
		if (error.status === 409) throw error;
		throw toTonUpstreamError(error);
	}
};

const getTokens = async (params, query = {}) => {
	const dashboard = await getAddress(params);
	const tokens = dashboard.tokenHoldings?.tokens || [];
	const page = Number(query.page || 0);
	const show = Number(query.show || 10);
	const slice = tokens.slice(page * show, page * show + show);

	return {
		balance: dashboard.tokenHoldings?.balance || "0",
		total: tokens.length,
		tokens: slice,
	};
};

const getTransactions = async (params, query = {}) => {
	const address = assertValidTonAddress(params.id);
	const page = String(query.page ?? "0");
	const show = String(query.show ?? "10");
	const limit = Number(show) || 10;
	const offset = (Number(page) || 0) * limit;

	try {
		const events = await tonApiGet(`/accounts/${encodeAccountId(address)}/events`, {
			limit,
			before_lt: query.before_lt,
		});
		const transactions = mapEventsToTransactions(events.events || [], address);
		return {
			pagination: { records: String(transactions.length), page, show },
			transactions,
		};
	} catch (error) {
		console.error("Error in TON getTransactions:", error.message);
		return {
			pagination: { records: "0", page, show },
			transactions: [],
		};
	}
};

const getTransaction = async (params) => {
	const eventId = String(params.id || "").trim();
	try {
		const event = await tonApiGet(`/events/${encodeURIComponent(eventId)}`);
		const account = event.account?.address || "";
		const txs = mapEventsToTransactions([event], account);
		if (!txs.length) {
			const error = new Error("transaction_not_found");
			error.status = 404;
			throw error;
		}
		return txs[0];
	} catch (error) {
		if (error.status === 404) throw error;
		const error404 = new Error("transaction_not_found");
		error404.status = 404;
		throw error404;
	}
};

module.exports = {
	mapEventsToTransactions,
	getAddress,
	getTokens,
	getTransactions,
	getTransaction,
};
