const moment = require("moment");
const SessionModule = require("../../Session/modules/session.module");
const ArweaveModule = require("../../Arweave/modules/arweave.module");
const ZNSPartsModule = require("./zns-parts.module");
const ZNSSearchModule = require("./zns-search.module");
const { resolveContentUrl, buildExplorerUrl } = require("../../Arweave/modules/arweave-gateway.module");
const { generateMnemonic } = require("../../Wallet/modules/helpers");
const { createEthWallet } = require("../../Wallet/modules/eth");
const { createSolanaWallet } = require("../../Wallet/modules/solana");
const { createBTCWallet } = require("../../Wallet/modules/btc");
const { generateSuiWalletFromMnemonic } = require("../../Wallet/modules/sui");
const { decrypt, encrypt, preview, encryptQR } = require("../../Wallet/modules/encryption");
const OfflineProofModule = require("../../../Core/offline-proof");
const IPFSModule = require("../../IPFS/modules/ipfs.module");
const config = require("../../../Core/config");
const jwt = require("jsonwebtoken");
const { confirmPayUniqueAddress } = require("../../purchase-zelf/modules/balance-checker.module");
const { addReferralReward, addPurchaseReward } = require("./zns-token.module");
const { createUnderName } = require("./undernames.module");
const { initTagUpdates, updateTags } = require("./sync-zelf-name-records.module");
const WalrusModule = require("../../Walrus/modules/walrus.module");

/**
 * lease zelfName
 * @param {Object} params
 * @param {Object} authUser
 */
const leaseZelfName = async (params, authUser) => {
	const { zelfName, duration, referralZelfName } = params;

	await _findDuplicatedZelfName(zelfName, "both", authUser);

	const referralZelfNameObject = await _validateReferral(referralZelfName, authUser);

	const decryptedParams = await ZNSPartsModule.decryptParams(params, authUser);

	const { face, password } = decryptedParams;

	const { eth, btc, solana, sui, zkProof, mnemonic } = await _createWalletsFromPhrase({
		...params,
		mnemonic: decryptedParams.mnemonic,
	});

	const dataToEncrypt = {
		publicData: {
			ethAddress: eth.address,
			solanaAddress: solana.address,
			btcAddress: btc.address,
			zelfName,
			origin: "online",
		},
		metadata: {
			mnemonic,
			solanaSecretKey: solana.secretKey,
		},
		faceBase64: face,
		password,
		_id: zelfName,
		tolerance: params.tolerance,
		addServerPassword: Boolean(params.addServerPassword),
	};

	const zelfNameObject = {
		zelfName,
		duration,
	};

	ZNSPartsModule.assignProperties(zelfNameObject, dataToEncrypt, { eth, btc, solana, sui }, { ...params, password });

	await ZNSPartsModule.generateZelfProof(dataToEncrypt, zelfNameObject);

	if (zelfNameObject.price === 0) {
		await _confirmFreeZelfName(zelfNameObject, referralZelfNameObject, authUser);
	} else {
		await _saveHoldZelfNameInIPFS(zelfNameObject, referralZelfNameObject, authUser);
	}

	return {
		...zelfNameObject,
		hasPassword: Boolean(password),
		pgp: await ZNSPartsModule.generatePGPKeys(
			dataToEncrypt,
			{
				eth,
				btc,
				solana,
				sui,
			},
			password
		),
	};
};

/**
 * decrypt zelfName
 * @param {Object} params
 * @param {Object} authUser
 */
const decryptZelfName = async (params, authUser) => {
	const zelfNameObjects = await _findZelfName({ zelfName: params.zelfName }, "both", authUser);

	const zelfNameObject = {
		...(zelfNameObjects.arweave?.[0] || {}),
		...(zelfNameObjects.ipfs?.[0] || {}),
	};

	const { face, password } = await _decryptParams(params, authUser);

	const decryptedZelfProof = await decrypt({
		addServerPassword: Boolean(params.addServerPassword),
		faceBase64: face,
		password,
		zelfProof: zelfNameObject.publicData.zelfProof || params.zelfProof,
	});

	if (decryptedZelfProof.error) {
		const error = new Error(decryptedZelfProof.error.code);
		error.status = 409;
		throw error;
	}

	const { mnemonic, zkProof, solanaSecretKey } = decryptedZelfProof.metadata;

	const { encryptedMessage, privateKey, tagsToAdd } = await initTagUpdates(zelfNameObject, {
		mnemonic,
		zkProof,
		solanaSecretKey,
		password,
	});

	if (tagsToAdd.length) {
		const { ipfs, arweave } = await updateTags(zelfNameObject, tagsToAdd);

		zelfNameObject.updatedIpfs = ipfs;

		zelfNameObject.updatedArweave = arweave;

		for (let index = 0; index < tagsToAdd.length; index++) {
			const tag = tagsToAdd[index];

			zelfNameObject.publicData[tag.name] = tag.value;
		}
	}

	if (!zelfNameObject.zelfProofQRCode) zelfNameObject.zelfProofQRCode = await ZNSPartsModule.urlToBase64(zelfNameObject.url);

	return {
		hasPassword: Boolean(password),
		image: zelfNameObject.zelfProofQRCode,
		metadata: config.env === "development" ? { mnemonic, zkProof, solanaSecretKey } : undefined,
		pgp: { encryptedMessage, privateKey },
		url: zelfNameObject.url,
		zelfName: zelfNameObject.publicData.zelfName,
		publicData: {
			...decryptedZelfProof.publicData,
			...zelfNameObject.publicData,
		},
		durationToken: jwt.sign(
			{
				zelfName: zelfNameObject.publicData.zelfName,
				exp: moment().add(1, "month").unix(),
			},
			config.JWT_SECRET
		),
		updatedIpfs: zelfNameObject.updatedIpfs,
		updatedArweave: zelfNameObject.updatedArweave,
	};
};

const _confirmFreeZelfName = async (zelfNameObject, referralZelfNameObject, authUser) => {
	const zelfName = zelfNameObject.zelfName.replace(".hold", "");

	const metadata = {
		hasPassword: zelfNameObject.hasPassword,
		zelfProof: zelfNameObject.zelfProof,
		zelfName,
		ethAddress: zelfNameObject.ethAddress,
		solanaAddress: zelfNameObject.solanaAddress,
		btcAddress: zelfNameObject.btcAddress,
		extraParams: {
			origin: zelfNameObject.origin || "online",
			suiAddress: zelfNameObject.suiAddress,
			price: zelfNameObject.price,
			duration: zelfNameObject.duration || 1,
			registeredAt: moment().format("YYYY-MM-DD HH:mm:ss"),
			expiresAt: moment().add(1, "year").format("YYYY-MM-DD HH:mm:ss"),
			type: "mainnet",
		},
	};

	if (referralZelfNameObject) {
		metadata.extraParams.referralZelfName = referralZelfNameObject.publicData?.zelfName || referralZelfNameObject.metadata?.zelfName;

		metadata.extraParams.referralSolanaAddress =
			referralZelfNameObject.publicData?.solanaAddress || referralZelfNameObject.metadata?.solanaAddress;
	}

	zelfNameObject.walrus = await WalrusModule.zelfNameRegistration(zelfNameObject.image, {
		hasPassword: metadata.hasPassword,
		zelfProof: metadata.zelfProof,
		publicData: metadata,
	});

	metadata.extraParams.walrus = zelfNameObject.walrus.blobId;

	metadata.extraParams = JSON.stringify(metadata.extraParams);

	zelfNameObject.ipfs = await IPFSModule.insert(
		{
			base64: zelfNameObject.image,
			name: zelfName,
			metadata,
			pinIt: true,
		},
		{ ...authUser, pro: true }
	);

	zelfNameObject.ipfs = await ZNSPartsModule.formatIPFSRecord(zelfNameObject.ipfs, true);

	delete zelfNameObject.ipfs.publicData.zelfProof;

	if (!zelfNameObject.publicData) zelfNameObject.publicData = {};

	zelfNameObject.publicData = Object.assign(zelfNameObject.publicData, zelfNameObject.ipfs.publicData);

	zelfNameObject.arweave = await ArweaveModule.zelfNameRegistration(zelfNameObject.image, {
		hasPassword: metadata.hasPassword,
		zelfProof: metadata.zelfProof,
		publicData: metadata,
	});
};

const _saveHoldZelfNameInIPFS = async (zelfNameObject, referralZelfNameObject, authUser) => {
	const holdName = `${zelfNameObject.zelfName}.hold`;

	const metadata = {
		zelfProof: zelfNameObject.zelfProof,
		zelfName: holdName,
		hasPassword: zelfNameObject.hasPassword,
		ethAddress: zelfNameObject.ethAddress,
		btcAddress: zelfNameObject.btcAddress,
		solanaAddress: zelfNameObject.solanaAddress,
		extraParams: {
			duration: zelfNameObject.duration || 1,
			type: "hold",
			origin: zelfNameObject.origin || "online",
			suiAddress: zelfNameObject.suiAddress,
			price: zelfNameObject.price,
			registeredAt: moment().format("YYYY-MM-DD HH:mm:ss"),
			expiresAt: moment().add(30, "day").format("YYYY-MM-DD HH:mm:ss"),
		},
	};

	if (referralZelfNameObject) {
		metadata.extraParams.referralZelfName = referralZelfNameObject.publicData?.zelfName || referralZelfNameObject.metadata?.zelfName;

		metadata.extraParams.referralSolanaAddress =
			referralZelfNameObject.publicData?.solanaAddress || referralZelfNameObject.metadata?.solanaAddress;
	}

	metadata.extraParams = JSON.stringify(metadata.extraParams);

	zelfNameObject.ipfs = await IPFSModule.insert(
		{
			base64: zelfNameObject.image,
			name: holdName,
			metadata,
			pinIt: true,
		},
		{ ...authUser, pro: true }
	);

	zelfNameObject.ipfs = await ZNSPartsModule.formatIPFSRecord(zelfNameObject.ipfs, true);

	delete zelfNameObject.ipfs.publicData.zelfProof;

	zelfNameObject.publicData = Object.assign(zelfNameObject.publicData, zelfNameObject.ipfs.publicData);
};

const _createWalletsFromPhrase = async (params) => {
	const _mnemonic = params.type === "import" ? params.mnemonic : generateMnemonic(params.wordsCount);

	const wordsArray = _mnemonic.split(" ");

	if (wordsArray.length !== 12 && wordsArray.length !== 24) throw new Error("409:mnemonic_invalid");

	const eth = createEthWallet(_mnemonic);
	const btc = createBTCWallet(_mnemonic);
	const solana = await createSolanaWallet(_mnemonic);
	const sui = await generateSuiWalletFromMnemonic(_mnemonic);
	const zkProof = await OfflineProofModule.createProof(_mnemonic);

	return {
		eth,
		btc,
		solana,
		sui,
		zkProof,
		mnemonic: _mnemonic,
	};
};

const _findDuplicatedZelfName = async (zelfName, environment = "both", authUser, returnResults = false) => {
	const searchResult = await ZNSSearchModule.searchZelfName(
		{
			zelfName,
			environment,
		},
		authUser
	);

	if (searchResult.available) return null;

	if (returnResults) return searchResult;

	const error = new Error("zelfName_is_taken");

	error.status = 409;

	throw error;
};

const _validateReferral = async (referralZelfName, authUser) => {
	if (!referralZelfName) return null;

	const searchResult = await ZNSSearchModule.searchZelfName(
		{
			zelfName: referralZelfName,
			environment: "mainnet",
		},
		authUser
	);

	let notFound = Boolean(searchResult.available);

	if (!notFound) return searchResult.ipfs?.length ? searchResult.ipfs[0] : searchResult.arweave[0];

	const error = new Error("zelfName_referring_you_not_found");

	error.status = 409;

	throw error;
};

/**
 * preview Zelf name
 * @param {String} zelfName
 * @param {Object} authUser
 */
const previewZelfName = async (params, authUser) => {
	try {
		let { ipfs, arweave } = await _findZelfName(
			{
				zelfName: params.zelfName,
				key: params.key,
				value: params.value,
			},
			params.environment,
			authUser
		);

		zelfNameRecords = ipfs || arweave;

		for (let index = 0; index < zelfNameObjects.length; index++) {
			const zelfNameObject = zelfNameObjects[index];

			if (zelfNameObject.ipfs_pin_hash && zelfNameObject.publicData.arweaveId) {
				zelfNameObject.url = await resolveContentUrl(zelfNameObject.publicData.arweaveId);

				zelfNameObject.explorerUrl = buildExplorerUrl(zelfNameObject.publicData.arweaveId);
			}

			zelfNameObject.source = zelfNameObject.ipfs_pin_hash ? "ipfs" : "arweave";

			zelfNameObject.preview = await preview({
				zelfProof: zelfNameObject.zelfProof,
			});
		}

		return zelfNameObjects;
	} catch (exception) {
		return await _previewWithIPFS(params, authUser);
	}
};

/**
 * preview with IPFS
 * @param {Object} params
 * @param {Object} authUser
 * @author Miguel Trevino
 */
const _previewWithIPFS = async (params, authUser) => {
	try {
		const searchResult = await ZNSSearchModule._searchInIPFS(params.environment, params, { ...authUser, pro: true }, false);

		if (!searchResult || searchResult?.available) throw new Error("404:not_found");

		const zelfNameObject = searchResult.ipfs?.length ? searchResult.ipfs[0] : searchResult.arweave[0] || searchResult[0];

		zelfNameObject.preview = await preview({
			zelfProof: zelfNameObject.zelfProof,
		});

		return searchResult;
	} catch (exception) {
		console.error({ exception });

		const error = new Error("zelfName_not_found");

		error.status = 404;

		throw error;
	}
};

const _findZelfName = async (params, environment = "both", authUser) => {
	const { zelfName, key, value } = params;

	const searchResults = await ZNSSearchModule.searchZelfName(
		{
			zelfName,
			key,
			value,
			environment,
		},
		authUser
	);

	if (!searchResults.arweave?.length && !searchResults.ipfs?.length) {
		const error = new Error(`zelfName_not_found`);
		error.status = 404;
		throw error;
	}

	const inArweave = Boolean(searchResults.arweave?.length);

	if (environment === "both") {
		return { arweave: searchResults.arweave, ipfs: searchResults.ipfs };
	}

	return inArweave ? searchResults.arweave[0] : searchResults.ipfs[0];
};

const _validatePassword = async (zelfProof, syncPassword) => {
	const jsonfile = require("../../../config/0012589021.json");

	let isValidPassword = false;

	try {
		await decrypt({
			faceBase64: jsonfile.mFace,
			password: syncPassword,
			os: "DESKTOP",
			zelfProof,
			addServerPassword: false,
		});
	} catch (exception) {
		console.error({ exception: exception.message });

		isValidPassword = Boolean(exception.message.includes("ERR_VERIFICATION_FAILED"));
	}

	if (!isValidPassword) {
		const error = new Error("zelfName_password_invalid");
		error.status = 409;
		throw error;
	}

	return isValidPassword;
};

const leaseOffline = async (params, authUser) => {
	const { zelfName, duration, zelfProof, zelfProofQRCode, sync, syncPublicData, syncPassword, referralZelfName } = params;

	let mainnetRecord = null;
	let holdRecord = null;
	let zelfNameRecords = [];

	try {
		const records = await previewZelfName({ zelfName, environment: "both" }, authUser);

		zelfNameRecords = records.ipfs || records.arweave;
	} catch (exception) {
		console.error({ exception });
	}

	if (sync && syncPublicData && syncPassword) {
		await _validatePassword(zelfProof, syncPassword);
	}

	for (let index = 0; index < zelfNameRecords.length; index++) {
		const ipfsRecord = zelfNameRecords[index];

		if (ipfsRecord.publicData.type === "hold") holdRecord = ipfsRecord;

		if (ipfsRecord.publicData.type === "mainnet") mainnetRecord = ipfsRecord;
	}

	let _preview = holdRecord?.preview || mainnetRecord?.preview;

	const zelfNameRecord = holdRecord || mainnetRecord;

	if (sync && (holdRecord || mainnetRecord)) {
		return await _syncOfflineZelfName(zelfNameRecord, syncPublicData);
	} else if (mainnetRecord) {
		const error = new Error("zelfName_purchased_already");
		error.status = 409;
		throw error;
	}

	const { price, reward, discount, priceWithoutDiscount, discountType } = ZNSPartsModule.calculateZelfNamePrice(
		zelfName.length - 5,
		duration,
		referralZelfName
	);

	if (!_preview) _preview = await preview({ zelfProof });

	if (!zelfName.includes(_preview.publicData?.zelfName?.toLowerCase())) {
		const error = new Error("zelfName_does_not_match_in_zelfProof");
		error.status = 409;
		throw error;
	}

	const zelfNameObject = {
		zelfName: `${zelfName}.hold`,
		zelfProof,
		image: zelfProofQRCode,
		price,
		reward,
		hasPassword: _preview.passwordLayer === "WithPassword" ? "true" : "false",
		ethAddress: _preview.publicData.ethAddress,
		btcAddress: _preview.publicData.btcAddress,
		solanaAddress: _preview.publicData.solanaAddress,
		suiAddress: _preview.publicData.suiAddress,
		duration: duration || 1,
		origin: "offline",
	};

	if (holdRecord)
		return {
			existed: true,
			...holdRecord,
			zelfName,
			preview: _preview,
			durationToken: jwt.sign(
				{
					zelfName,
					exp: moment().add(30, "day").unix(),
				},
				config.JWT_SECRET
			),
		};

	const _zelfProof = holdRecord?.publicData?.zelfProof || mainnetRecord?.publicData?.zelfProof;

	if (_zelfProof && zelfProof !== _zelfProof) {
		const error = new Error("zelfProof_does_not_match_in_hold");
		error.status = 409;
		throw error;
	}

	if (zelfNameObject.price === 0) {
		await _confirmFreeZelfName(zelfNameObject, referralZelfName, authUser);
	} else {
		zelfNameObject.ipfs = await IPFSModule.insert(
			{
				base64: zelfNameObject.image,
				name: zelfNameObject.zelfName,
				metadata: {
					zelfProof: zelfNameObject.zelfProof,
					zelfName: zelfNameObject.zelfName,
					ethAddress: _preview.publicData.ethAddress,
					btcAddress: _preview.publicData.btcAddress,
					solanaAddress: _preview.publicData.solanaAddress,
					extraParams: JSON.stringify({
						origin: "offline",
						registeredAt: moment().format("YYYY-MM-DD HH:mm:ss"),
						hasPassword: _preview.passwordLayer === "WithPassword" ? "true" : "false",
						duration: duration || 1,
						price: zelfNameObject.price,
						expiresAt: moment().add(30, "day").format("YYYY-MM-DD HH:mm:ss"),
						suiAddress: _preview.publicData.suiAddress,
						v: "2",
						type: "hold",
					}),
				},
				pinIt: true,
			},
			{ ...authUser, pro: true }
		);

		zelfNameObject.ipfs = await ZNSPartsModule.formatIPFSRecord(zelfNameObject.ipfs, true);
	}

	return {
		...zelfNameObject,
		durationToken: jwt.sign(
			{
				zelfName,
				exp: moment().add(30, "day").unix(),
			},
			config.JWT_SECRET
		),
	};
};

const createZelfPay = async (zelfNameObject, currentCount = 1) => {
	const params = zelfNameObject.publicData || zelfNameObject.metadata;

	const zelfName = params.zelfName.split(".hold")[0];

	if (!zelfName) {
		const error = new Error("zelfName_not_found");
		error.status = 404;
		throw error;
	}

	params.duration = params.duration || 1;

	params.price = ZNSPartsModule.calculateZelfNamePrice(zelfName.split(".")[0].length, params.duration, params.referralZelfName).price;

	const paymentName = `${zelfName}`.replace(".zelf", ".zelfpay");

	const mnemonic = generateMnemonic(12);
	const jsonfile = require("../../../config/0012589021.json");
	const eth = createEthWallet(mnemonic);
	const btc = createBTCWallet(mnemonic);
	const solana = await createSolanaWallet(mnemonic);
	const zkProof = await OfflineProofModule.createProof(mnemonic);

	const dataToEncrypt = {
		publicData: {
			ethAddress: eth.address,
			solanaAddress: solana.address,
			btcAddress: btc.address,
			customerZelfName: zelfNameObject.zelfName,
			zelfName: paymentName,
			currentCount: `${currentCount}`,
		},
		metadata: {
			mnemonic,
			zkProof,
		},
		faceBase64: jsonfile.faceBase64,
		password: jsonfile.password,
		_id: paymentName,
		tolerance: "REGULAR",
		addServerPassword: true,
	};

	const zelfProof = await encrypt(dataToEncrypt);

	const image = await encryptQR(dataToEncrypt);

	const payload = {
		base64: image,
		name: paymentName,
		metadata: {
			hasPassword: zelfNameObject.hasPassword,
			zelfProof,
			type: "mainnet",
			ethAddress: eth.address,
			solanaAddress: solana.address,
			btcAddress: btc.address,
			zelfName: paymentName,
			extraParams: JSON.stringify({
				expiresAt: moment().add(100, "year").format("YYYY-MM-DD HH:mm:ss"),
				registeredAt: moment().format("YYYY-MM-DD HH:mm:ss"),
				price: params.price || 24,
				duration: params.duration || 1,
				count: `${currentCount}`,
			}),
		},
		pinIt: true,
	};

	const ipfs = await IPFSModule.insert(payload, { pro: true });

	const arweave = await ArweaveModule.zelfNameRegistration(image, {
		hasPassword: "true",
		zelfProof,
		publicData: {
			ethAddress: params.ethAddress,
			btcAddress: params.btcAddress,
			solanaAddress: params.solanaAddress,
			zelfName: paymentName,
			type: "mainnet",
			expiresAt: moment().add(100, "year").format("YYYY-MM-DD HH:mm:ss"),
			count: `${currentCount}`,
		},
	});

	return {
		ipfs: await ZNSPartsModule.formatIPFSRecord(ipfs, false),
		arweave,
	};
};

const updateZelfPay = async (zelfPayObject, updates = {}) => {
	const params = zelfPayObject.publicData;

	const { newDuration } = updates;

	const zelfName = params.zelfName.split(".hold")[0];

	if (!zelfName) {
		const error = new Error("zelfName_not_found");
		error.status = 404;
		throw error;
	}

	const price =
		zelfPayObject.publicData.price ||
		ZNSPartsModule.calculateZelfNamePrice(zelfName.length - 5, newDuration || zelfPayObject.publicData.duration, updates.referralZelfName).price;

	const newCount = parseInt(zelfPayObject.publicData.count || 0) + 1;

	const base64 = await ZNSPartsModule.urlToBase64(zelfPayObject.url);

	const payload = {
		base64,
		name: zelfPayObject.publicData.zelfName,
		metadata: {
			hasPassword: "true",
			zelfProof: zelfPayObject.publicData.zelfProof,
			type: "mainnet",
			ethAddress: zelfPayObject.publicData.ethAddress,
			solanaAddress: zelfPayObject.publicData.solanaAddress,
			btcAddress: zelfPayObject.publicData.btcAddress,
			zelfName: zelfPayObject.publicData.zelfName,
			extraParams: JSON.stringify({
				registeredAt: moment().format("YYYY-MM-DD HH:mm:ss"),
				expiresAt: moment().add(100, "year").format("YYYY-MM-DD HH:mm:ss"),
				price,
				duration: newDuration || zelfPayObject.publicData.duration,
				count: `${newCount}`,
			}),
		},
		pinIt: true,
	};

	const arweave = await ArweaveModule.zelfNameRegistration(base64, {
		zelfProof: zelfPayObject.publicData.zelfProof,
		publicData: payload.metadata,
	});

	//remove the previous ipfs record
	await IPFSModule.unPinFiles([zelfPayObject.ipfs_pin_hash || zelfPayObject.IpfsHash]);

	const ipfs = await IPFSModule.insert(payload, { pro: true });

	return {
		price,
		updates,
		zelfName,
		ipfs: await ZNSPartsModule.formatIPFSRecord(ipfs, true),
		arweave,
	};
};

const _decryptParams = async (data, authUser) => {
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

/**
 * get ZelfName
 * @param {String} zelfName
 * @param {Object} authUser
 * @author Miguel Trevino
 */
const _getZelfNameToConfirm = async (zelfName, authUser) => {
	const zelfNameRecords = await previewZelfName({ zelfName, environment: "both" }, authUser);

	let isMainnet = false;

	for (let index = 0; index < zelfNameRecords.length; index++) {
		const record = zelfNameRecords[index];

		inMainnet = Boolean(record.publicData?.type === "mainnet" || !record.publicData?.zelfName.includes(".hold"));
	}

	if (!zelfNameRecords.length) {
		const error = new Error("zelfName_not_found");
		error.status = 404;
		throw error;
	}

	if (zelfNameRecords.length === 2 || inMainnet) {
		const error = new Error("zelfName_purchased_already");
		error.status = 409;
		throw error;
	}

	const zelfNameObject = zelfNameRecords[0];

	let zelfPayNameObject = null;

	if (zelfNameObject) {
		// bring it from zelfPay
		const zelfPay = `${zelfName.replace(".zelf.hold", ".zelfpay").replace(".zelf", ".zelfpay")}`;

		let zelfPayRecords = [];

		zelfPayRecords = await ZNSSearchModule.searchZelfName(
			{
				zelfName: zelfPay,
				environment: "mainnet",
			},
			authUser
		);

		zelfPayNameObject = zelfPayRecords.ipfs?.length ? zelfPayRecords.ipfs[0] : zelfPayRecords.arweave?.length ? zelfPayRecords.arweave[0] : null;

		if (!zelfPayNameObject) {
			const error = new Error("zelfPay_not_found");
			error.status = 404;
			throw error;
		}
	}

	return {
		zelfNameObject,
		isMainnet,
		zelfPayNameObject,
	};
};

/**
 * lease confirmation
 * @param {Object} data
 * @param {Object} authUser
 * @author Miguel Trevino
 */
const leaseConfirmation = async (data, authUser) => {
	const { network, zelfName, confirmationData } = data;

	const { zelfNameObject, zelfPayNameObject } = await _getZelfNameToConfirm(zelfName, authUser);

	let payment = false;

	switch (zelfNameObject.publicData.price === 0 ? "free" : network) {
		case "ETH":
			payment = await confirmPayUniqueAddress(network, confirmationData);

			break;
		case "SOL":
			payment = await confirmPayUniqueAddress(network, confirmationData);

			break;
		case "BTC":
			payment = await confirmPayUniqueAddress(network, confirmationData);

			break;
		case "free":
			payment = {
				confirmed: true,
			};

			break;

		default:
			break;
	}

	if (payment?.confirmed) {
		return await _confirmZelfNamePurchase(zelfNameObject);
	}

	return {
		zelfNameObject,
		zelfName,
		payment,
	};
};

/**
 *
 * @param {Object} zelfNameObject
 * @returns {Object} - Returns the referral reward and the cloned Zelf Name records
 */
const _confirmZelfNamePurchase = async (zelfNameObject) => {
	const { masterIPFSRecord, masterArweaveRecord, reward } = await _cloneZelfNameToProduction(zelfNameObject);

	return {
		ipfs: [masterIPFSRecord],
		arweave: masterArweaveRecord,
		reward,
	};
};

/**
 * clone zelf name to production
 * @param {Object} zelfNameObject
 * @author Miguel Trevino
 */
const _cloneZelfNameToProduction = async (zelfNameObject) => {
	const duration = zelfNameObject.publicData.duration === "lifetime" ? 100 : zelfNameObject.publicData.duration || 1;

	const expiresAt = moment().add(duration, "year").format("YYYY-MM-DD HH:mm:ss");

	const zelfName = zelfNameObject.preview?.publicData?.zelfName || zelfNameObject.publicData.zelfName.replace(".hold", "");

	const payload = {
		base64: zelfNameObject.zelfProofQRCode,
		name: zelfName,
		metadata: {
			hasPassword: `${Boolean(zelfNameObject.preview?.passwordLayer === "Password") ||
				Boolean(zelfNameObject.hasPassword) ||
				zelfNameObject.publicData.hasPassword ||
				true
				}`,
			zelfProof: zelfNameObject.publicData.zelfProof,
			zelfName,
			ethAddress: zelfNameObject.preview.publicData.ethAddress,
			solanaAddress: zelfNameObject.preview.publicData.solanaAddress,
			btcAddress: zelfNameObject.preview.publicData.btcAddress,
			extraParams: JSON.stringify({
				...(zelfNameObject.preview.publicData.suiAddress && { suiAddress: zelfNameObject.preview.publicData.suiAddress }),
				origin: zelfNameObject.preview.publicData.origin || "online",
				registeredAt: moment().format("YYYY-MM-DD HH:mm:ss"),
				expiresAt,
			}),
			type: "mainnet",
		},
		pinIt: true,
	};

	const masterArweaveRecord = config.zelfProof.skipArweave
		? {}
		: await ArweaveModule.zelfNameRegistration(zelfNameObject.zelfProofQRCode, {
			hasPassword: payload.metadata.hasPassword,
			zelfProof: payload.metadata.zelfProof,
			publicData: {
				...payload.metadata,
				...(zelfNameObject.preview.publicData.suiAddress && { suiAddress: zelfNameObject.preview.publicData.suiAddress }),
				expiresAt,
			},
		});

	await IPFSModule.unPinFiles([zelfNameObject.ipfs_pin_hash]);

	const masterIPFSRecord = await IPFSModule.insert(payload, { pro: true });

	let reward;

	zelfNameObject.publicData.referralZelfName
		? await addReferralReward({
			ethAddress: masterIPFSRecord.metadata.ethAddress,
			solanaAddress: masterIPFSRecord.metadata.solanaAddress,
			zelfName: masterIPFSRecord.metadata.zelfName,
			zelfNamePrice: zelfNameObject.publicData.price,
			referralZelfName: zelfNameObject.publicData.referralZelfName,
			referralSolanaAddress: zelfNameObject.publicData.referralSolanaAddress,
			ipfsHash: masterIPFSRecord.IpfsHash,
			arweaveId: masterArweaveRecord?.id,
		})
		: "no_referral";

	reward = await addPurchaseReward({
		ethAddress: masterIPFSRecord.metadata.ethAddress,
		solanaAddress: masterIPFSRecord.metadata.solanaAddress,
		zelfName: masterIPFSRecord.metadata.zelfName,
		zelfNamePrice: zelfNameObject.publicData.price,
		ipfsHash: masterIPFSRecord.IpfsHash,
		arweaveId: masterArweaveRecord?.id,
	});

	if (config.env === "production") {
		await createUnderName({
			parentName: config.arwave.parentName,
			undername: zelfNameObject.publicData.zelfName.split(".zelf")[0],
			publicData: zelfNameObject.publicData,
		});
	}

	return {
		masterArweaveRecord,
		masterIPFSRecord: await ZNSPartsModule.formatIPFSRecord(masterIPFSRecord, true),
		reward,
	};
};



const _syncOfflineZelfName = async (zelfNameRecord, syncPublicData) => {
	const syncKeys = Object.keys(syncPublicData);

	const tagsToAdd = [];

	let ipfs = null;
	let arweave = null;

	for (let index = 0; index < syncKeys.length; index++) {
		const key = syncKeys[index];

		if (!zelfNameRecord.publicData[key]) {
			zelfNameRecord.publicData[key] = syncPublicData[key];
			tagsToAdd.push({ key, value: syncPublicData[key] });
		}
	}

	if (!tagsToAdd.length) {
		const error = new Error("Nothing to sync");
		error.status = 409;
		throw error;
	}

	({ ipfs, arweave } = await updateTags(zelfNameRecord, tagsToAdd));

	return {
		tagsToAdd,
		...ipfs,
		arweave,
		durationToken: jwt.sign(
			{
				zelfName: zelfNameRecord.zelfName,
				exp: moment().add(30, "day").unix(),
			},
			config.JWT_SECRET
		),
	};
};

module.exports = {
	searchZelfName: ZNSSearchModule.searchZelfName,
	decryptZelfName,
	leaseZelfName,
	leaseOffline,
	createZelfPay,
	updateZelfPay,
	leaseConfirmation,
	previewZelfName,
	saveInProduction: _cloneZelfNameToProduction,
	findDuplicatedZelfName: _findDuplicatedZelfName,
	createWalletsFromPhrase: _createWalletsFromPhrase,
	confirmFreeZelfName: _confirmFreeZelfName,
	saveHoldZelfNameInIPFS: _saveHoldZelfNameInIPFS,
	validateReferral: _validateReferral,
};
