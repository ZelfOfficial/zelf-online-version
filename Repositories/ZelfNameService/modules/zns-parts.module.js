const SessionModule = require("../../Session/modules/session.module");
const ArweaveModule = require("../../Arweave/modules/arweave.module");
const IPFSModule = require("../../IPFS/modules/ipfs.module");
const config = require("../../../Core/config");
const { resolveContentUrl, buildExplorerUrl } = require("../../Arweave/modules/arweave-gateway.module");
const moment = require("moment");
const axios = require("axios");
const { encrypt, encryptQR } = require("../../Wallet/modules/encryption");
const { mergeAddressKeyvaluesIntoPublicData, expandStoredExtraParams } = require("../../Tags/modules/tags-addresses.module");

const zelfNamePricing = {
	1: { 1: 240, 2: 432, 3: 612, 4: 768, 5: 900, lifetime: 3600 },
	2: { 1: 120, 2: 216, 3: 306, 4: 384, 5: 450, lifetime: 1800 },
	3: { 1: 72, 2: 130, 3: 184, 4: 230, 5: 270, lifetime: 1080 },
	4: { 1: 36, 2: 65, 3: 92, 4: 115, 5: 135, lifetime: 540 },
	5: { 1: 30, 2: 54, 3: 76, 4: 96, 5: 112, lifetime: 450 },
	"6-15": { 1: 24, 2: 43, 3: 61, 4: 77, 5: 90, lifetime: 360 },
	16: { 1: 23, 2: 41, 3: 59, 4: 74, 5: 86, lifetime: 345 },
	17: { 1: 22, 2: 40, 3: 56, 4: 70, 5: 82, lifetime: 330 },
	18: { 1: 21, 2: 38, 3: 54, 4: 67, 5: 79, lifetime: 315 },
	19: { 1: 20, 2: 36, 3: 51, 4: 64, 5: 75, lifetime: 300 },
	20: { 1: 19, 2: 34, 3: 48, 4: 61, 5: 72, lifetime: 285 },
	21: { 1: 18, 2: 32, 3: 46, 4: 58, 5: 68, lifetime: 270 },
	22: { 1: 17, 2: 31, 3: 43, 4: 54, 5: 64, lifetime: 255 },
	23: { 1: 16, 2: 29, 3: 41, 4: 51, 5: 60, lifetime: 240 },
	24: { 1: 15, 2: 27, 3: 38, 4: 48, 5: 56, lifetime: 225 },
	25: { 1: 14, 2: 25, 3: 36, 4: 45, 5: 53, lifetime: 210 },
	26: { 1: 13, 2: 23, 3: 33, 4: 42, 5: 49, lifetime: 195 },
	27: { 1: 12, 2: 22, 3: 31, 4: 38, 5: 45, lifetime: 180 },
};

/**
 * Get Zelf Name price based on name length and duration
 * @param {number} length - The length of the Zelf name
 * @param {string} duration - Duration ("1", "2", "3", "4", "5", "lifetime")
 * @returns {number} - Price of the Zelf name
 */
const calculateZelfNamePrice = (length, duration = 1, referralZelfName) => {
	if (!["1", "2", "3", "4", "5", "lifetime"].includes(`${duration}`))
		throw new Error("Invalid duration. Use '1', '2', '3', '4', '5' or 'lifetime'.");

	let price = 24;

	if (length >= 6 && length <= 15) {
		price = zelfNamePricing["6-15"][duration];
	} else if (zelfNamePricing[length]) {
		price = zelfNamePricing[length][duration];
	} else {
		throw new Error("Invalid name length. Length must be between 1 and 27.");
	}

	// Adjust price for development environment
	price = config.token.priceEnv === "development" ? price / 30 : price;

	const priceWithoutDiscount = Number(price);
	let discount = 10;
	let discountType = "percentage";

	const whitelist = config.token.whitelist || "";

	if (whitelist.length && referralZelfName && whitelist.includes(referralZelfName)) {
		const referralDiscounts = config.token.whitelist.split(",");

		const referralDiscount = referralDiscounts.find((discount) => {
			const [name] = discount.split(":");
			return name === referralZelfName || name === `${referralZelfName}.zelf`;
		});

		if (referralDiscount) {
			const [zelfName, amount] = referralDiscount.split(":");

			if (amount.includes("%")) {
				discountType = "percentage";
				discount = parseInt(amount);
				price = price - price * (discount / 100);
			} else {
				discount = parseInt(amount);
				discountType = "amount";
				price = price - discount;
			}
		}
	} else if (referralZelfName) {
		price = price - price * 0.1;
	}

	// Round up to 2 decimal places
	return {
		price: Math.max(Math.ceil(price * 100) / 100, 0),
		currency: "USD",
		reward: Math.max(Math.ceil((price / config.token.rewardPrice) * 100) / 100, 0),
		discount,
		priceWithoutDiscount,
		discountType,
	};
};

const decryptParams = async (data, authUser) => {
	if (data.removePGP) {
		return {
			password: data.password,
			mnemonic: data.mnemonic,
			face: data.faceBase64,
		};
	}

	// Only decrypt if the values exist and are not null/undefined
	const password = data.password ? await SessionModule.sessionDecrypt(data.password, authUser) : null;
	const mnemonic = data.mnemonic ? await SessionModule.sessionDecrypt(data.mnemonic, authUser) : null;
	const face = data.faceBase64 ? await SessionModule.sessionDecrypt(data.faceBase64, authUser) : null;

	return { password, mnemonic, face };
};

const formatArweaveRecord = async (transactionRecord) => {
	const zelfNameObject = {
		id: transactionRecord.node?.id,
		url: await resolveContentUrl(transactionRecord.node?.id),
		explorerUrl: buildExplorerUrl(transactionRecord.node?.id),
		publicData: {},
		zelfProofQRCode: await ArweaveModule.arweaveIDToBase64(transactionRecord.node?.id),
	};

	for (let index = 0; index < transactionRecord.node?.tags.length; index++) {
		const tag = transactionRecord.node?.tags[index];

		zelfNameObject.publicData[tag.name] = tag.value;
	}

	if (zelfNameObject.publicData.leaseExpiresAt) zelfNameObject.publicData.expiresAt = zelfNameObject.publicData.leaseExpiresAt;

	const zelfProofTag = transactionRecord.node?.tags.find((tag) => tag.name === "zelfProof");

	const zelfNameTag = transactionRecord.node?.tags.find((tag) => tag.name === "zelfName");

	zelfNameObject.zelfProof = zelfProofTag ? zelfProofTag.value : null;

	zelfNameObject.zelfName = zelfNameTag ? zelfNameTag.value : null;

	if (zelfNameObject.publicData.extraParams) {
		const extraParams = expandStoredExtraParams(zelfNameObject.publicData.extraParams);

		Object.assign(zelfNameObject.publicData, extraParams);

		delete zelfNameObject.publicData.extraParams;
	}

	return zelfNameObject;
};

const removeExpiredRecords = async (records) => {
	// const now = moment();
	// for (let index = records.length - 1; index >= 0; index--) {
	// 	const record = records[index];
	// 	const expiresAt = moment(record.metadata.keyvalues.expiresAt);
	// 	const isExpired = now.isAfter(expiresAt);
	// 	const type = record.metadata.keyvalues.type;
	// 	if (isExpired) {
	// 		records.splice(index, 1);
	// 		if (type === "hold") {
	// 			record.ipfs_pin_hash ? await IPFSModule.unPinFiles([record.ipfs_pin_hash]) : "do nothing";
	// 			continue;
	// 		}
	// 	}
	// }
};

const formatIPFSRecord = async (ipfsRecord, foundInArweave) => {
	const zelfNameObject = {
		...ipfsRecord,
		metadata: undefined,
		publicData: {
			name: ipfsRecord.metadata.name || ipfsRecord.metadata.zelfName,
		},
		zelfName: ipfsRecord.metadata.name || ipfsRecord.metadata.zelfName,
	};

	Object.assign(zelfNameObject.publicData, ipfsRecord.metadata.keyvalues || ipfsRecord.metadata);

	if (zelfNameObject.publicData.payment) {
		const payment = JSON.parse(zelfNameObject.publicData.payment);

		// assign all payment properties to the publicData
		Object.assign(zelfNameObject.publicData, payment);

		delete zelfNameObject.publicData.payment;
	}

	if (zelfNameObject.publicData.extraParams) {
		const extraParams = expandStoredExtraParams(zelfNameObject.publicData.extraParams);

		// assign all extraParams properties to the publicData
		Object.assign(zelfNameObject.publicData, extraParams);

		delete zelfNameObject.publicData.extraParams;
	}

	mergeAddressKeyvaluesIntoPublicData(zelfNameObject.publicData);

	if (zelfNameObject.publicData.leaseExpiresAt) zelfNameObject.publicData.expiresAt = zelfNameObject.publicData.leaseExpiresAt;

	// Always set zelfProof and zelfProofQRCode for IPFS records
	zelfNameObject.zelfProof = zelfNameObject.publicData.zelfProof;

	zelfNameObject.zelfProofQRCode = await _IPFSToBase64(zelfNameObject.url);

	return zelfNameObject;
};

const _IPFSToBase64 = async (url) => {
	try {
		const encryptedResponse = await axios.get(url, {
			responseType: "arraybuffer",
		});

		if (encryptedResponse?.data) {
			const base64Image = Buffer.from(encryptedResponse.data).toString("base64");

			return `data:image/png;base64,${base64Image}`;
		}
	} catch (exception) {
		console.error({ VWEx: exception, url });

		return exception?.message;
	}
};

const urlToBase64 = async (url) => {
	try {
		const encryptedResponse = await axios.get(url, {
			responseType: "arraybuffer",
		});

		if (encryptedResponse?.data) {
			const base64Image = Buffer.from(encryptedResponse.data).toString("base64");

			return `data:image/png;base64,${base64Image}`;
		}
	} catch (exception) {
		console.error({ VWEx: exception });

		return exception?.message;
	}
};

const _arweaveIDToBase64 = async (id) => ArweaveModule.arweaveIDToBase64(id);

const generatePGPKeys = async (dataToEncrypt, addresses, password) => {
	const { eth, solana, sui } = addresses;
	const { mnemonic, zkProof } = dataToEncrypt.metadata;

	let encryptedMessage;

	let privateKey;

	const pgpKeys = await SessionModule.walletEncrypt(
		{
			mnemonic,
			zkProof,
			solanaPrivateKey: solana.secretKey,
			suiSecretKey: sui.secretKey,
		},
		eth.address,
		password
	);

	encryptedMessage = pgpKeys.encryptedMessage;

	privateKey = pgpKeys.privateKey;

	return {
		encryptedMessage,
		privateKey,
	};
};

const assignProperties = (zelfNameObject, dataToEncrypt, addresses, payload) => {
	const { price, reward, priceWithoutDiscount, discount, discountType } = calculateZelfNamePrice(
		zelfNameObject.zelfName.split(".")[0].length,
		zelfNameObject.duration,
		payload.referralZelfName
	);

	const { eth, btc, solana, sui } = addresses;

	zelfNameObject.price = price;
	zelfNameObject.reward = reward;
	zelfNameObject.discount = discount;
	zelfNameObject.discountType = discountType;
	zelfNameObject.publicData = dataToEncrypt.publicData;
	zelfNameObject.ethAddress = eth.address;
	zelfNameObject.btcAddress = btc.address;
	zelfNameObject.solanaAddress = solana.address;
	zelfNameObject.suiAddress = sui.address;
	zelfNameObject.hasPassword = `${Boolean(payload.password)}`;

	zelfNameObject.metadata = payload.removePGP
		? dataToEncrypt.metadata
		: payload.previewZelfProof
		? {
				mnemonic: dataToEncrypt.metadata.mnemonic
					.split(" ")
					.map((word, index, array) => (index < 2 || index >= array.length - 2 ? word : "****"))
					.join(" "),
				solanaSecretKey: `${dataToEncrypt.metadata.solanaSecretKey.slice(0, 6)}****${dataToEncrypt.metadata.solanaSecretKey.slice(-6)}`,
				suiSecretKey: `${sui.secretKey.slice(0, 6)}****${sui.secretKey.slice(-6)}`,
		  }
		: undefined;
};

const _generateZelfProof = async (dataToEncrypt, zelfNameObject) => {
	zelfNameObject.zelfProof = await encrypt(dataToEncrypt);

	if (!zelfNameObject.zelfProof) throw new Error("409:Wallet_could_not_be_encrypted");

	zelfNameObject.image = await encryptQR(dataToEncrypt);
};

module.exports = {
	calculateZelfNamePrice,
	decryptParams,
	formatArweaveRecord,
	removeExpiredRecords,
	formatIPFSRecord,
	urlToBase64,
	generatePGPKeys,
	assignProperties,
	generateZelfProof: _generateZelfProof,
};
