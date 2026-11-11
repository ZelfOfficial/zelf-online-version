const config = require("../../../Core/config");
const { signToken, TOKEN_TYPES } = require("../../../Core/jwt-claims");
const { searchZelfName, createZelfPay, updateZelfPay } = require("./zns.v2.module");
const moment = require("moment");
const { getTickerPrice } = require("../../binance/modules/binance.module");

const { confirmPayUniqueAddress } = require("../../purchase-zelf/modules/balance-checker.module");
const ArweaveModule = require("../../Arweave/modules/arweave.module");
const IPFSModule = require("../../IPFS/modules/ipfs.module");
const ZNSPartsModule = require("./zns-parts.module");
const { addReferralReward, addPurchaseReward, getPurchaseReward } = require("./zns-token.module");
const { getDomainConfig } = require("../../Tags/config/supported-domains");
const { buildAddressKeyvalues, mergeAddressKeyvaluesIntoPublicData } = require("../../Tags/modules/tags-addresses.module");

const renewMyZelfName = async (params, authUser) => {
	if (!authUser || !authUser.zelfName) {
		const error = new Error("zelfName_not_authenticated");
		error.status = 404;
		throw error;
	}

	let payment;

	switch (params.network) {
		case "ETH":
			payment = await confirmPayUniqueAddress("ETH", authUser);
			break;
		case "SOL":
			payment = await confirmPayUniqueAddress("SOL", authUser);
			break;
		case "BTC":
			payment = await confirmPayUniqueAddress("BTC", authUser);
			break;
		default:
			break;
	}

	const publicKeys = await searchZelfName({ zelfName: authUser.zelfName });

	const zelfNameObjectFound = Boolean(publicKeys.ipfs?.length || publicKeys.arweave?.length);

	if (!zelfNameObjectFound && !payment.confirmed) {
		const error = new Error("zelfName_not_found");
		error.status = 404;
		throw error;
	}

	if (payment.confirmed && !zelfNameObjectFound) {
		return {
			payment,
			confirmed: true,
			zelfName: authUser.zelfName,
			reward: await getPurchaseReward(authUser.zelfName?.replace(".hold", "")),
		};
	}

	let zelfNameObject;

	if (publicKeys.ipfs?.length === 1) {
		zelfNameObject = publicKeys.ipfs[0];
	} else if (publicKeys.ipfs?.length > 1) {
		zelfNameObject = publicKeys.ipfs.reduce((latest, current) => {
			return moment(current.publicData.expiresAt).isAfter(moment(latest.publicData.expiresAt)) ? current : latest;
		});
	} else if (publicKeys.arweave?.length === 1) {
		zelfNameObject = publicKeys.arweave[0];
	} else if (publicKeys.arweave?.length > 1) {
		zelfNameObject = publicKeys.arweave.reduce((latest, current) => {
			return moment(current.publicData.expiresAt).isAfter(moment(latest.publicData.expiresAt)) ? current : latest;
		});
	}

	// second + time
	if (
		(zelfNameObject.publicData.renewedAt &&
			authUser.payment?.registeredAt &&
			moment(zelfNameObject.publicData.renewedAt).isAfter(moment(authUser.payment.registeredAt))) ||
		(!zelfNameObject.publicData.renewedAt &&
			authUser.payment?.registeredAt &&
			moment(zelfNameObject.publicData.registeredAt).isAfter(moment(authUser.payment.registeredAt)))
	) {
		return {
			cache: true,
			payment,
			publicData: zelfNameObject.publicData,
			reward: await getPurchaseReward(zelfNameObject.publicData.zelfName, moment(authUser.payment.registeredAt)),
		};
	}

	if (payment?.confirmed) {
		const { masterArweaveRecord, masterIPFSRecord, reward, referralSolanaAddress, referralZelfName } = await _addDurationToZelfName(authUser);

		return {
			referralSolanaAddress,
			referralZelfName,
			confirmed: true,
			ipfs: masterIPFSRecord,
			arweave: masterArweaveRecord,
			reward,
			payment,
		};
	}

	return {
		renew: authUser.zelfName.includes(".hold") ? false : true,
		confirmed: payment.confirmed,
		payment,
		referralSolanaAddress: zelfNameObject.publicData.referralSolanaAddress,
		referralZelfName: zelfNameObject.publicData.referralZelfName,
	};
};

const _addDurationToZelfName = async (authUser, preview = {}, passedZelfNameObject) => {
	const { zelfName, duration, eventID, eventPrice } = authUser;

	let zelfNameObject = passedZelfNameObject;

	if (!zelfNameObject) {
		const publicKeys = await searchZelfName({ zelfName });

		zelfNameObject = publicKeys.ipfs?.length ? publicKeys.ipfs[0] : publicKeys.arweave?.length ? publicKeys.arweave[0] : null;

		if (!zelfNameObject) {
			const error = new Error("zelfName_not_found");
			error.status = 404;
			throw error;
		}
	}

	const base64 = await ZNSPartsModule.urlToBase64(zelfNameObject.url);

	const ethAddress = preview.publicData?.ethAddress || zelfNameObject.publicData.ethAddress;
	const solanaAddress = preview.publicData?.solanaAddress || zelfNameObject.publicData.solanaAddress;
	const btcAddress = preview.publicData?.btcAddress || zelfNameObject.publicData.btcAddress;
	const suiAddress = preview.publicData?.suiAddress || zelfNameObject.publicData.suiAddress || "";
	const origin = preview.publicData?.origin || zelfNameObject.publicData.origin || "online";

	const payload = {
		base64,
		name: zelfName.replace(".hold", ""),
		metadata: {
			hasPassword: zelfNameObject.publicData.hasPassword,
			zelfProof: zelfNameObject.publicData.zelfProof,
			zelfName: zelfName.replace(".hold", ""),
			ethAddress,
			solanaAddress,
			btcAddress,
			extraParams: JSON.stringify({
				suiAddress,
				origin,
				registeredAt:
					zelfNameObject.publicData.type === "mainnet" ? zelfNameObject.publicData.registeredAt : moment().format("YYYY-MM-DD HH:mm:ss"),
				renewedAt: zelfNameObject.publicData.type === "mainnet" ? moment().format("YYYY-MM-DD HH:mm:ss") : undefined,
				expiresAt: moment(zelfNameObject.publicData.expiresAt).add(duration, "year").format("YYYY-MM-DD HH:mm:ss"),
				count: parseInt(zelfNameObject.publicData.count) + 1,
				eventID,
			}),
			type: "mainnet",
		},
		pinIt: true,
	};

	const masterArweaveRecord = await ArweaveModule.zelfNameRegistration(base64, {
		hasPassword: payload.metadata.hasPassword,
		zelfProof: payload.metadata.zelfProof,
		publicData: payload.metadata,
	});

	await IPFSModule.unPinFiles([zelfNameObject.ipfs_pin_hash || zelfNameObject.IpfsHash]);

	const masterIPFSRecord = await IPFSModule.insert(payload, { pro: true });

	let reward = null;

	const price =
		eventPrice ||
		zelfNameObject.publicData.price ||
		ZNSPartsModule.calculateZelfNamePrice(
			zelfNameObject.publicData.zelfName.split(".")[0].length,
			duration,
			zelfNameObject.publicData.referralZelfName
		).price;

	if (zelfNameObject.publicData.type === "hold") {
		reward = await addPurchaseReward({
			ethAddress: masterIPFSRecord.metadata.ethAddress,
			solanaAddress: masterIPFSRecord.metadata.solanaAddress,
			zelfName: masterIPFSRecord.metadata.zelfName,
			zelfNamePrice: price,
			ipfsHash: masterIPFSRecord.IpfsHash,
			arweaveId: masterArweaveRecord.id,
		});
	}

	zelfNameObject.publicData.referralZelfName
		? await addReferralReward({
			ethAddress: masterIPFSRecord.metadata.ethAddress,
			solanaAddress: masterIPFSRecord.metadata.solanaAddress,
			zelfName: masterIPFSRecord.metadata.zelfName,
			zelfNamePrice: price,
			referralZelfName: zelfNameObject.publicData.referralZelfName,
			referralSolanaAddress: zelfNameObject.publicData.referralSolanaAddress,
			ipfsHash: masterIPFSRecord.IpfsHash,
			arweaveId: masterArweaveRecord.id,
		})
		: "no_referral";

	return {
		referralZelfName: zelfNameObject.publicData.referralZelfName,
		referralSolanaAddress: zelfNameObject.publicData.referralSolanaAddress,
		masterArweaveRecord,
		masterIPFSRecord: await ZNSPartsModule.formatIPFSRecord(masterIPFSRecord, true),
		reward,
	};
};

const transferMyZelfName = async (zelfName, newOwner) => {
	// 1. validate that the zelfName exists
	// 2. validate that the newOwner exists
	// 3. transfer the zelfName

	return {
		transfer: true,
	};
};

const _fetchZelfPayRecord = async (zelfNameObject, currentCount, duration = 1) => {
	const { zelfName, registeredAt, renewedAt, referralZelfName } = zelfNameObject.publicData;

	const _zelfName = zelfName.includes(".hold") ? zelfName.replace(".zelf.hold", ".zelfpay") : zelfName.replace(".zelf", ".zelfpay");

	let zelfPayRecords = await searchZelfName({ zelfName: _zelfName });

	zelfPayRecords = zelfPayRecords.ipfs?.length
		? zelfPayRecords.ipfs.filter((record) => {
			const comparisonDate = renewedAt ? moment(renewedAt) : moment(registeredAt);
			return comparisonDate.isBefore(record.publicData.registeredAt);
		})
		: zelfPayRecords.arweave?.filter((record) => {
			const comparisonDate = renewedAt ? moment(renewedAt) : moment(registeredAt);
			return comparisonDate.isBefore(record.publicData.registeredAt);
		});

	let renewZelfPayObject = null;

	const recordsFound = zelfPayRecords?.length || 0;

	if (recordsFound < currentCount || recordsFound === 0) {
		zelfNameObject.publicData.duration = duration || 1;
		// we need to create a new zelfPay record
		const newZelfPayRecord = await createZelfPay(zelfNameObject, currentCount + 1);

		return newZelfPayRecord.ipfs || newZelfPayRecord.arweave;
	}

	for (let index = 0; index < zelfPayRecords.length; index++) {
		const record = zelfPayRecords[index];

		if (record.publicData.type !== "mainnet") continue;

		const count = parseInt(record.publicData.count);

		const recordDuration = parseInt(record.publicData.duration);

		if ((!renewZelfPayObject || count > parseInt(renewZelfPayObject.publicData.count)) && recordDuration === duration) {
			renewZelfPayObject = record;
		}
	}

	if (!renewZelfPayObject) {
		zelfNameObject.publicData.duration = duration || 1;

		const newZelfPayRecord = await createZelfPay(zelfNameObject, currentCount + 1);

		return newZelfPayRecord.ipfs || newZelfPayRecord.arweave;
	}

	return renewZelfPayObject;
};

const _updateOldZelfNameObject = async (zelfNameObject) => {
	const duration = zelfNameObject.publicData.duration || 1;

	const calculation =
		zelfNameObject.publicData.price ||
		ZNSPartsModule.calculateZelfNamePrice(
			zelfNameObject.publicData.zelfName.split(".")[0].length,
			duration,
			zelfNameObject.publicData.referralZelfName
		);

	const type = zelfNameObject.publicData.type || (zelfNameObject.publicData.zelfName.includes(".hold") ? "hold" : "mainnet");

	const expiresAt =
		zelfNameObject.publicData.expiresAt ||
		zelfNameObject.publicData.leaseExpiresAt ||
		(type === "hold" ? moment().add(30, "day").format("YYYY-MM-DD HH:mm:ss") : moment().add(duration, "year").format("YYYY-MM-DD HH:mm:ss"));

	const registeredAt = expiresAt
		? moment(expiresAt).isAfter("2026-01-01")
			? moment(expiresAt).subtract(1, "year").format("YYYY-MM-DD HH:mm:ss")
			: moment(expiresAt).subtract(1, "month").format("YYYY-MM-DD HH:mm:ss")
		: moment().format("YYYY-MM-DD HH:mm:ss");

	mergeAddressKeyvaluesIntoPublicData(zelfNameObject.publicData);

	if (zelfNameObject.publicData.payment) {
		// remove the payment from the object (it is in a string format, we need to do JSON.parse)
		zelfNameObject.publicData.payment = JSON.parse(zelfNameObject.publicData.payment);

		zelfNameObject.publicData.referralZelfName = zelfNameObject.publicData.payment?.referralZelfName;
		zelfNameObject.publicData.referralSolanaAddress = zelfNameObject.publicData.payment?.referralSolanaAddress;
	}

	const payload = {
		base64: await ZNSPartsModule.urlToBase64(zelfNameObject.url),
		name: zelfNameObject.publicData.zelfName,
		pinIt: true,
		metadata: {
			zelfProof: zelfNameObject.publicData.zelfProof,
			zelfName: zelfNameObject.publicData.zelfName,
			hasPassword: zelfNameObject.publicData.hasPassword,
			extraParams: JSON.stringify({
				origin: zelfNameObject.publicData.origin,
				suiAddress: zelfNameObject.publicData.suiAddress,
				price: calculation.price,
				duration: type === "hold" ? duration : undefined,
				registeredAt: moment(registeredAt).isAfter(moment()) ? moment().format("YYYY-MM-DD HH:mm:ss") : registeredAt,
				expiresAt,
				referralZelfName: zelfNameObject.publicData.referralZelfName,
				referralSolanaAddress: zelfNameObject.publicData.referralSolanaAddress,
			}),
			...buildAddressKeyvalues(zelfNameObject.publicData),
			type,
		},
	};

	//remove the previous ipfs record
	const deletedRecord = await IPFSModule.unPinFiles([zelfNameObject.ipfs_pin_hash || zelfNameObject.IpfsHash]);

	const ipfs = await IPFSModule.insert(payload, { pro: true });

	const formattedIPFS = await ZNSPartsModule.formatIPFSRecord(ipfs, true);

	let formattedArweave = null;

	if (payload.metadata.type !== "hold") {
		// save the record also in Arweave
		formattedArweave = await ArweaveModule.zelfNameRegistration(payload.base64, {
			zelfProof: payload.metadata.zelfProof,
			publicData: payload.metadata,
		});
	}

	zelfNameObject.publicData = formattedIPFS.publicData;

	return {
		ipfs: [formattedIPFS],
		arweave: [formattedArweave],
	};
};

const howToRenewMyZelfName = async (params) => {
	const { domain, tagName } = params;

	const domainConfig = getDomainConfig(domain);

	if (!domainConfig) throw new Error(`Unsupported domain: ${domain}`);

	const searchResult = await searchTag({ tagName, domain, domainConfig, environment: "all" }, authUser);

	if (searchResult.available) return searchResult;

	const duration = params.duration === "lifetime" ? "lifetime" : parseInt(params.duration || 1);

	const recordsWithSameName = publicKeys.ipfs?.length || publicKeys.arweave?.length;

	const renewZelfPayObject = await _fetchZelfPayRecord(zelfNameObject, recordsWithSameName, duration);

	if (!renewZelfPayObject) {
		const error = new Error("zelfPayRecord_not_found");
		error.status = 404;
		throw error;
	}

	const paymentAddress = {
		ethAddress: renewZelfPayObject.publicData.ethAddress,
		btcAddress: renewZelfPayObject.publicData.btcAddress,
		solanaAddress: renewZelfPayObject.publicData.solanaAddress,
	};

	const ethPrices = await calculateCryptoValue("ETH", renewZelfPayObject.publicData.price);

	const solPrices = await calculateCryptoValue("SOL", renewZelfPayObject.publicData.price);

	const returnData = {
		paymentAddress,
		ethPrices,
		solPrices,
		zelfName: zelfNameObject.publicData.zelfName,
		expiresAt: zelfNameObject.publicData.expiresAt,
		ttl: moment().add("2", "hours").unix(),
		duration: parseInt(duration || 1),
		count: parseInt(renewZelfPayObject.publicData.count),
		payment: {
			registeredAt: renewZelfPayObject.publicData.registeredAt,
			expiresAt: renewZelfPayObject.publicData.expiresAt,
			referralZelfName: zelfNameObject.publicData.referralZelfName,
			referralSolanaAddress: zelfNameObject.publicData.referralSolanaAddress,
		},
	};

	const signedDataPrice = signRecordData(returnData);

	return {
		...returnData,
		signedDataPrice,
	};
};

const calculateCryptoValue = async (token = "ETH", price_) => {
	try {
		const { price } = await getTickerPrice({ symbol: `${token}` });

		if (!price) throw new Error(`Unable to fetch ${token} price`);

		const cryptoValue = price_ / price;

		return {
			amountToSend: parseFloat(cryptoValue.toFixed(7)),
			ratePriceInUSD: parseFloat(parseFloat(price).toFixed(5)),
			price: price_,
		};
	} catch (error) {
		throw error;
	}
};

const signRecordData = (recordData) => {
	try {
		const token = signToken(recordData, config.JWT_SECRET, { typ: TOKEN_TYPES.quote, expiresIn: "2h" });

		return token;
	} catch (error) {
		return { success: false, error: error.message };
	}
};

const syncZelfNameInIPFSAndArweave = async (zelfNameObject, mnemonic) => { };

module.exports = {
	renewMyZelfName,
	transferMyZelfName,
	howToRenewMyZelfName,
	updateOldZelfNameObject: _updateOldZelfNameObject,
	addDurationToZelfName: _addDurationToZelfName,
	syncZelfNameInIPFSAndArweave,
};
