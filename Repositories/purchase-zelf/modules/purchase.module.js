const config = require("../../../Core/config");
const { getTickerPrice } = require("../../binance/modules/binance.module");
const Mailgun = require("../../../Core/mailgun");
const Model = require("../../Subscribers/models/subscriber.model");
const MongoORM = require("../../../Core/mongo-orm");
const { calculateZelfNamePrice } = require("../../ZelfNameService/modules/zns-parts.module");
const { createZelfPay, searchZelfName } = require("../../ZelfNameService/modules/zns.v2.module");
const { getAddress } = require("../../etherscan/modules/etherscan-scrapping.module");
const ZNSPartsModule = require("../../ZelfNameService/modules/zns-parts.module");
const solanaModule = require("../../Solana/modules/solana-scrapping.module");
const { getBalance } = require("../../bitcoin/modules/bitcoin-scrapping.module");
const jwt = require("jsonwebtoken");
const { signToken, TOKEN_TYPES } = require("../../../Core/jwt-claims");
const secretKey = config.signedData.key;

const templatesMap = {
	es: {
		Purchase_receipt: {
			subject: "Purchase receipt",
			template: "purchase receipt",
		},
	},
	en: {
		Purchase_receipt: {
			subject: "Purchase receipt",
			template: "purchase receipt",
		},
	},
};

/**
 * search Zelf Lease
 * @param {String} zelfName
 */
const searchZelfLease = async (zelfName) => {
	const previewData = await searchZelfName({ zelfName: zelfName });

	const zelfNameObject = previewData.ipfs?.[0] || previewData.arweave?.[0];

	if (!zelfNameObject?.publicData) {
		const error = new Error("zelfName_not_found");
		error.status = 404;
		throw error;
	}

	if (!zelfNameObject.publicData.price) {
		zelfNameObject.publicData.duration = zelfNameObject.publicData.duration || 1;

		zelfNameObject.publicData.price = ZNSPartsModule.calculateZelfNamePrice(zelfName.length - 5, zelfNameObject.publicData.duration).price;
	}

	const { price, duration, expiresAt, referralZelfName, referralSolanaAddress } = zelfNameObject.publicData;

	if (zelfNameObject.publicData.type !== "hold") {
		const error = new Error("zelfName_purchased_already");
		error.status = 409;
		throw error;
	}

	let zelfPayNameObject = null;
	let zelfPayRecords = [];

	try {
		zelfPayRecords = await searchZelfName(
			{
				zelfName: zelfName.replace(".zelf", ".zelfpay"),
				environment: "mainnet",
			},
			{}
		);
	} catch (exception) {
		console.error({ exception });
	}

	zelfPayNameObject = zelfPayRecords.ipfs?.[0] || zelfPayRecords.arweave?.[0];

	if (!zelfPayNameObject) {
		const createdZelfPay = await createZelfPay(zelfNameObject);

		zelfPayNameObject = createdZelfPay.ipfs || createdZelfPay.arweave;
	}

	if (!zelfPayNameObject) {
		const error = new Error("zelfPayName_not_found");
		error.status = 404;
		throw error;
	}

	const cryptoValue = await calculateCryptoValue("ETH", price);

	const network = cryptoValue.network;
	const amountToSend = cryptoValue.amountToSend;
	const ratePriceInUSD = cryptoValue.ratePriceInUSD;

	const recordData = {
		network: network,
		amountToSend: cryptoValue.amountToSend,
		price: cryptoValue.price,
		ratePriceInUSD: cryptoValue.ratePriceInUSD,
	};

	const signedDataPrice = signRecordData(recordData, secretKey);

	const paymentAddress = {
		ethAddress: zelfPayNameObject.publicData.ethAddress,
		btcAddress: zelfPayNameObject.publicData.btcAddress,
		solanaAddress: zelfPayNameObject.publicData.solanaAddress,
	};

	return {
		paymentAddress,
		zelfName,
		price,
		duration: parseInt(duration),
		expiresAt,
		referralZelfName,
		network,
		amountToSend,
		referralSolanaAddress,
		ratePriceInUSD,
		signedDataPrice,
	};
};

const selectMethod = async (network, price) => {
	if (network === "CB") {
		return {
			network,
			price: price,
			amountToSend: price,
		};
	}

	const cryptoValue = await calculateCryptoValue(network, price);

	const recordData = {
		network: network,
		amountToSend: cryptoValue.amountToSend,
		price: cryptoValue.price,
		ratePriceInUSD: cryptoValue.ratePriceInUSD,
	};

	const signedDataPrice = signRecordData(recordData, secretKey);

	return { ...recordData, signedDataPrice };
};

const pay = async (zelfName_, network, signedDataPrice) => {
	const _zelfPay = zelfName_.replace(/\.zelf(\.hold)?$/, ".zelfpay");
	const zelfNameRecords = await searchZelfName({
		zelfName: _zelfPay,
		environment: "mainnet",
	});

	if (!zelfNameRecords?.ipfs?.length && !zelfNameRecords?.arweave?.length) {
		const error = new Error("zelfPayName_not_found");
		error.status = 404;
		throw error;
	}

	const zelfPayObject = zelfNameRecords?.ipfs[0] || zelfNameRecords?.arweave[0];

	let selectedAddress = null;

	switch (network.toUpperCase()) {
		case "BTC":
			selectedAddress = zelfPayObject.publicData.btcAddress;
			break;
		case "ETH":
			selectedAddress = zelfPayObject.publicData.ethAddress;
			break;
		case "SOL":
			selectedAddress = zelfPayObject.publicData.solanaAddress;
			break;
		default:
			break;
	}

	const { price, amountToSend } = verifyRecordData(signedDataPrice, secretKey);

	const priceInIPFS =
		parseFloat(zelfPayObject.publicData.price) || ZNSPartsModule.calculateZelfNamePrice(zelfName_.split(".zelf")[0].length, 1).price;

	if (price !== priceInIPFS && config.token.priceEnv !== "development") {
		const error = new Error(`Validation_failed:${price}!==${priceInIPFS}`);
		error.status = 409;
		throw error;
	}

	return await checkoutPayUniqueAddress(network, amountToSend, selectedAddress);
};

const checkoutPayUniqueAddress = async (network, amountToSend, selectedAddress) => {
	const balance = await {
		ETH: checkoutETH,
		SOL: checkoutSOLANA,
		BTC: checkoutBICOIN,
	}[network]?.(selectedAddress);

	if (balance === 0) {
		return {
			transactionStatus: false,
			transactionDescription: "pending",
			amountDetected: 0,
		};
	}

	let amountDetected = balance;
	let transactionStatus = false;
	let transactionDescription = "pending";
	let remainingAmount = 0;

	try {
		if (amountDetected >= Number(amountToSend)) {
			transactionStatus = true;
			transactionDescription = amountDetected === Number(amountToSend) ? "successful" : "overPayment";
		} else {
			transactionDescription = "partialPayment";
			remainingAmount = Number(amountToSend) - amountDetected;
		}
	} catch (error) {
		transactionDescription = "confirmationError";
		transactionStatus = false;
	}

	const confirmationData = signRecordData({ amountDetected, selectedAddress }, secretKey, TOKEN_TYPES.purchase);

	return {
		transactionDescription,
		transactionStatus,
		amountDetected,
		remainingAmount: parseFloat(parseFloat(remainingAmount).toFixed(7)),
		confirmationData: confirmationData,
	};
};

const checkoutETH = async (address) => {
	try {
		const balanceETH = await getAddress({
			address,
		});

		const balance = parseFloat(parseFloat(balanceETH.balance).toFixed(7));

		return balance;
	} catch (error) {
		console.error(error);
	}

	return 0;
};

const checkoutSOLANA = async (address) => {
	try {
		const balanceSOLANA = await solanaModule.getAddress({ id: address });

		const balance = parseFloat(parseFloat(balanceSOLANA.balance).toFixed(7));

		return balance;
	} catch (error) {
		console.error(error);
	}

	return 0;
};

const checkoutBICOIN = async (address) => {
	try {
		const balanceBICOIN = await getBalance({ id: address });

		const balance = parseFloat(parseFloat(balanceBICOIN.balance).toFixed(7));

		return balance;
	} catch (error) {
		console.error(error);
	}

	return 0;
};

const getReceiptEmail = async (body) => {
	const { zelfName, transactionDate, price, expires, year, email } = body;

	const calculatedPrice = calculateZelfNamePrice(zelfName.split(".zelf")[0].length, year);

	const discount = Math.round((subtotal.price - price) * 100) / 100;

	const formatDate = (date) =>
		new Intl.DateTimeFormat("en-US", {
			month: "short",
			day: "numeric",
			year: "numeric",
			hour: "numeric",
			minute: "numeric",
			second: "numeric",
			hour12: true,
		}).format(new Date(date));

	return await sendEmail({
		language: "es",
		template: "Purchase_receipt",
		zelfName,
		transactionDate: formatDate(transactionDate),
		price,
		subtotal: calculatedPrice.price,
		discount,
		expires: formatDate(expires.replace(/-/g, "/")),
		year,
		email,
	});
};

//calcular precio en la difrente redes
const calculateCryptoValue = async (network, price_) => {
	try {
		const { price } = await getTickerPrice({ symbol: `${network}` });

		if (!price) {
			throw new Error(`No se encontró información para la criptomoneda: ${network}`);
		}

		const cryptoValue = price_ / price;

		return {
			network,
			amountToSend: cryptoValue.toFixed(7),
			ratePriceInUSD: parseFloat(parseFloat(price).toFixed(5)),
			price: price_,
		};
	} catch (error) {
		throw error;
	}
};

const sendEmail = async (payload) => {
	payload.language ??= "es";

	const emailTemplate = templatesMap[payload.language] ? templatesMap[payload.language][payload.template] : templatesMap.en[payload.template];

	// Format year label to be singular or plural
	const yearLabel = payload.year === 1 ? "1 YEAR" : `${payload.year} YEARS`;

	const extraParams = {
		"recipient-variables": {
			[payload.email]: {
				transactionDate: payload.transactionDate,
				subtotal: payload.subtotal,
				discount: payload.discount,
				total: payload.price,
				expires: payload.expires,
				year: payload.year,
				yearLabel: yearLabel,
				tagName: payload.tagName,
			},
		},
	};

	try {
		email = await Mailgun.sendEmail(payload.email, emailTemplate.subject, emailTemplate.template, extraParams);

		const existingSubscriber = await get({
			where_email: payload.email,
			findOne: true,
		});

		const subscriber =
			existingSubscriber ||
			new Model({
				email: payload.email,
				name: payload.name,
				//lists: [list],
			});

		await subscriber.save();

		return { message: `payment_receipt_sent_successfully` };
	} catch (exception) {
		console.error({
			sendEmailException: exception,
			hola: true,
		});
		exception.status = 409;
		throw exception;
	}
};

const get = async (params) => {
	const queryParams = { ...params };
	return await MongoORM.buildQuery(queryParams, Model, null, []);
};

const signRecordData = (recordData, secretKey, typ = TOKEN_TYPES.record) => {
	try {
		const token = signToken(recordData, secretKey, { typ });
		return token;
	} catch (error) {
		return { success: false, error: error.message };
	}
};

const verifyRecordData = (token, secretKey) => {
	try {
		const decodedData = jwt.verify(token, secretKey);
		return decodedData;
	} catch (error) {
		error.status = 409;
		throw error;
	}
};

module.exports = {
	searchZelfLease,
	getReceiptEmail,
	selectMethod,
	pay,
	sendEmail,
};
