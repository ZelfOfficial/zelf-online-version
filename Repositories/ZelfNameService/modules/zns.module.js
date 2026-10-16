const ArweaveModule = require("../../Arweave/modules/arweave.module");
const { resolveContentUrl, buildExplorerUrl } = require("../../Arweave/modules/arweave-gateway.module");
const { generateMnemonic } = require("../../Wallet/modules/helpers");
const { createEthWallet } = require("../../Wallet/modules/eth");
const { createSolanaWallet } = require("../../Wallet/modules/solana");
const { createBTCWallet } = require("../../Wallet/modules/btc");
const SessionModule = require("../../Session/modules/session.module");
const { encrypt, decrypt, preview, encryptQR } = require("../../Wallet/modules/encryption");
const OfflineProofModule = require("../../../Core/offline-proof");
const IPFSModule = require("../../IPFS/modules/ipfs.module");
const moment = require("moment");
const config = require("../../../Core/config");
const { addReferralReward, addPurchaseReward } = require("./zns-token.module");
const jwt = require("jsonwebtoken");
const { createUnderName } = require("./undernames.module");
const { confirmPayUniqueAddress } = require("../../purchase-zelf/modules/balance-checker.module");
const ZNSPartsModule = require("./zns-parts.module");

const evmCompatibleTickers = [
	"ETH", // Ethereum
	"BNB", // Binance Smart Chain
	"MATIC", // Polygon
	"AVAX", // Avalanche
	"FTM", // Fantom
	"ARB", // Arbitrum
	"OP", // Optimism
	"CRO", // Cronos
	"ONE", // Harmony
	"KLAY", // Klaytn
	"xDAI", // Gnosis Chain
	"GLMR", // Moonbeam
	"CELO", // Celo
	"OKT", // OKX Chain
	"AURORA", // Aurora (NEAR EVM)
].join(","); // Create a single string of tickers;

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
 *
 * @param {*} params
 * @param {*} authUser
 */
const searchZelfName = async (params, authUser) => {
	const query = params.zelfName ? { key: "zelfName", value: params.zelfName } : { key: params.key, value: params.value };

	if (params.duration) query.duration = params.duration;

	try {
		const searchResults = await ArweaveModule.search(params.zelfName || params.key === "zelfName" ? params.value : null, query);

		if (searchResults?.available) {
			const error = new Error("not_found_in_arweave");

			error.status = 404;

			throw error;
		}

		const zelfNames = [];

		const hideRecordsWithoutRegisteredAt = Boolean(searchResults.length >= 2);

		for (let index = 0; index < searchResults.length; index++) {
			const zelfNameObject = await ZNSPartsModule.formatArweaveRecord(searchResults[index]);

			if (hideRecordsWithoutRegisteredAt && !zelfNameObject.publicData.registeredAt) continue;

			zelfNameObject.zelfProof = zelfNameObject.zelfProof.replace(/ /g, "+");

			zelfNames.push(zelfNameObject);
		}

		return {
			arweave: zelfNames,
			ipfs: await _searchInIPFS(params.environment, query, authUser, true),
		};
	} catch (exception) {
		console.error({ exception: exception });

		return await _searchInIPFS(params.environment, query, authUser);
	}
};

const _removeExpiredRecords = async (records) => {
	const now = moment();

	for (let index = records.length - 1; index >= 0; index--) {
		const record = records[index];

		const extraParams = JSON.parse(record.metadata.keyvalues.extraParams || "{}");

		const expiresAt = moment(record.metadata.keyvalues.expiresAt || extraParams.expiresAt);

		const type = record.metadata.keyvalues.type;

		const isExpired = now.isAfter(expiresAt);

		if (isExpired && type === "hold") {
			records.splice(index, 1);

			record.ipfs_pin_hash ? await IPFSModule.unPinFiles([record.ipfs_pin_hash]) : "do nothing";

			continue;
		}
	}
};

const _retriveFromIPFSByEnvironment = async (ipfsRecords, environment, query, authUser) => {
	switch (environment) {
		case "hold":
			ipfsRecords.push(
				...(await IPFSModule.get(
					{
						key: query.key || "zelfName",
						value: `${query.value || query.zelfName}.hold`,
					},
					authUser
				))
			);
			break;
		case "mainnet":
			ipfsRecords.push(...(await IPFSModule.get(query, authUser)));
			break;

		default:
			try {
				ipfsRecords.push(...(await IPFSModule.get(query, authUser)));
			} catch (exception) {
				console.error({ mainNetIPFSError: exception });
			}

			try {
				ipfsRecords.push(
					...(await IPFSModule.get(
						{
							key: query.key || "zelfName",
							value: `${query.value || query.zelfName}.hold`,
						},
						authUser
					))
				);
			} catch (exception) {
				console.error({ holdIPFSError: exception });
			}

			break;
	}

	await _removeExpiredRecords(ipfsRecords);
};

/**
 * search in IPFS
 * @param {Object} params
 * @param {Object} authUser
 * @author Miguel Trevino
 */
const _searchInIPFS = async (environment = "both", query, authUser, foundInArweave) => {
	const zelfName = query.value || query.zelfName;

	const { price, reward } = zelfName.includes(".zelf")
		? ZNSPartsModule.calculateZelfNamePrice(zelfName.split(".zelf")[0].length, query.duration)
		: { price: 0, reward: 0 };

	try {
		let ipfsRecords = [];

		await _retriveFromIPFSByEnvironment(ipfsRecords, environment, query, authUser);

		if (!ipfsRecords.length) {
			return foundInArweave
				? []
				: zelfName && zelfName.includes(".zelf")
					? {
						price,
						reward,
						zelfName,
						available: true,
					}
					: null;
		}

		const zelfNamesInIPFS = [];

		for (let index = 0; index < ipfsRecords.length; index++) {
			const ipfsRecord = ipfsRecords[index];

			if (environment === "both") {
				zelfNamesInIPFS.push(await ZNSPartsModule.formatIPFSRecord(ipfsRecord, foundInArweave));

				continue;
			}

			if (
				(environment === "hold" && ipfsRecord.metadata.keyvalues.type === "hold") ||
				(environment === "mainnet" && (!ipfsRecord.metadata.keyvalues.type || ipfsRecord.metadata.keyvalues.type === "mainnet"))
			) {
				zelfNamesInIPFS.push(await ZNSPartsModule.formatIPFSRecord(ipfsRecord, foundInArweave));
			}
		}

		return foundInArweave ? zelfNamesInIPFS : { ipfs: zelfNamesInIPFS };
	} catch (exception) {
		console.error({ _searchInIPFS_exception: exception });

		return foundInArweave
			? []
			: query.key === "zelfName"
				? {
					price,
					reward,
					zelfName,
					available: true,
				}
				: null;
	}
};

const _createWalletsFromPhrase = async (params, authUser) => {
	const { face, password, mnemonic } = await _decryptParams(params, authUser);

	const _mnemonic = params.type === "import" ? mnemonic : generateMnemonic(params.wordsCount);
	const wordsArray = _mnemonic.split(" ");
	if (wordsArray.length !== 12 && wordsArray.length !== 24) throw new Error("409:mnemonic_invalid");

	const eth = createEthWallet(_mnemonic);
	const btc = createBTCWallet(_mnemonic);
	const solana = await createSolanaWallet(_mnemonic);
	const zkProof = await OfflineProofModule.createProof(_mnemonic);

	return { eth, btc, solana, zkProof, mnemonic: _mnemonic, face, password };
};

/**
 * lease zelfName
 * @param {Object} params
 * @param {Object} authUser
 */
const leaseZelfName = async (params, authUser) => {
	const { zelfName, duration, referralZelfName } = params;

	await _findDuplicatedZelfName(zelfName, "both", authUser);

	const referralZelfNameObject = await _validateReferral(referralZelfName, authUser);

	const { eth, btc, solana, zkProof, mnemonic, face, password } = await _createWalletsFromPhrase(params, authUser);

	const zelfNameObject = {};

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
			zkProof,
		},
		faceBase64: face,
		password,
		_id: zelfName,
		tolerance: params.tolerance,
		addServerPassword: Boolean(params.addServerPassword),
	};

	zelfNameObject.zelfName = zelfName;

	const { price, priceWithoutDiscount, reward, discount, discountType } = ZNSPartsModule.calculateZelfNamePrice(
		zelfName.length - 5,
		duration,
		referralZelfName
	);

	zelfNameObject.price = price;
	zelfNameObject.reward = reward;
	zelfNameObject.discount = discount;
	zelfNameObject.discountType = discountType;
	zelfNameObject.publicData = dataToEncrypt.publicData;
	zelfNameObject.ethAddress = eth.address;
	zelfNameObject.btcAddress = btc.address;
	zelfNameObject.solanaAddress = solana.address;
	zelfNameObject.hasPassword = `${Boolean(password)}`;
	zelfNameObject.metadata = params.previewZelfProof ? dataToEncrypt.metadata : undefined;
	zelfNameObject.duration = duration;

	zelfNameObject.zelfProof = await encrypt(dataToEncrypt);

	if (!zelfNameObject.zelfProof) throw new Error("409:Wallet_could_not_be_encrypted");

	zelfNameObject.image = await encryptQR(dataToEncrypt);

	await _createPaymentCharge(zelfNameObject, { referralZelfName, referralZelfNameObject }, authUser);

	if (zelfNameObject.price === 0) {
		zelfNameObject.confirmation = await _confirmZelfNamePurchase({
			...zelfNameObject,
			ipfs_pin_hash: zelfNameObject.ipfs.IpfsHash,
			publicData: {
				...zelfNameObject.publicData,
				price: priceWithoutDiscount,
				referralZelfName,
				referralSolanaAddress: referralZelfNameObject?.publicData?.solanaAddress || referralZelfNameObject?.metadata?.solanaAddress,
				zelfProof: zelfNameObject.zelfProof,
				...dataToEncrypt.publicData,
			},
			zelfProofQRCode: zelfNameObject.image,
			preview: { publicData: dataToEncrypt.publicData },
		});

		zelfNameObject.ipfs = Array.isArray(zelfNameObject.confirmation.ipfs)
			? zelfNameObject.confirmation.ipfs[0]
			: zelfNameObject.confirmation.ipfs;
	}

	return {
		...zelfNameObject,
		hasPassword: Boolean(password),
		durationToken: jwt.sign(
			{
				zelfName,
				exp: moment().add(12, "hour").unix(),
			},
			config.JWT_SECRET
		),
	};
};

const _createPaymentCharge = async (zelfNameObject, referral, authUser) => {
	const { referralZelfName, referralZelfNameObject } = referral;

	const holdName = `${zelfNameObject.zelfName}.hold`;

	const metadata = {
		zelfProof: zelfNameObject.zelfProof,
		zelfName: holdName,
		hasPassword: zelfNameObject.hasPassword || "false",
		ethAddress: zelfNameObject.ethAddress,
		solanaAddress: zelfNameObject.solanaAddress,
		btcAddress: zelfNameObject.btcAddress,
		payment: {
			price: zelfNameObject.price,
			duration: zelfNameObject.duration || 1,
			expiresAt: moment().add(12, "hour").format("YYYY-MM-DD HH:mm:ss"),
		},
		type: "hold",
	};

	if (referralZelfName && referralZelfNameObject) {
		metadata.payment.referralZelfName = referralZelfName;

		metadata.payment.referralSolanaAddress = referralZelfNameObject?.publicData?.solanaAddress || referralZelfNameObject?.metadata?.solanaAddress;
	}

	metadata.payment = JSON.stringify(metadata.payment);

	zelfNameObject.ipfs = await IPFSModule.insert(
		{
			base64: zelfNameObject.image,
			name: holdName,
			metadata,
			pinIt: true,
		},
		{ ...authUser, pro: true }
	);

	await _createReceivingWallets(zelfNameObject, authUser);
};

const _createReceivingWallets = async (zelfNameObject) => {
	if (zelfNameObject.price === 0) {
		return {
			ipfsRecord: null,
			arweaveRecord: null,
		};
	}

	const mnemonic = generateMnemonic(12);
	const jsonfile = require("../../../config/0012589021.json");
	const eth = createEthWallet(mnemonic);
	const btc = createBTCWallet(mnemonic);
	const solana = await createSolanaWallet(mnemonic);

	const zkProof = await OfflineProofModule.createProof(mnemonic);

	// save it now in ipfs and arweave
	const paymentName = `${zelfNameObject.zelfName}`.replace(".zelf", ".zelfpay");

	const dataToEncrypt = {
		publicData: {
			ethAddress: eth.address,
			solanaAddress: solana.address,
			btcAddress: btc.address,
			customerZelfName: zelfNameObject.zelfName,
			zelfName: paymentName,
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
			extraParams: JSON.stringify({
				expiresAt: moment().add(100, "year").format("YYYY-MM-DD HH:mm:ss"),
				price: zelfNameObject.price,
			}),
			zelfName: paymentName,
		},
		pinIt: true,
	};

	const ipfsRecord = await IPFSModule.insert(payload, { pro: true });

	const arweaveRecord = await ArweaveModule.zelfNameRegistration(image, {
		hasPassword: "true",
		zelfProof,
		publicData: {
			...dataToEncrypt.publicData,
			zelfName: paymentName,
			type: "mainnet",
			expiresAt: moment().add(100, "year").format("YYYY-MM-DD HH:mm:ss"),
		},
	});

	return {
		ipfsRecord,
		arweaveRecord,
	};
};

/**
 * lease confirmation
 * @param {Object} data
 * @param {Object} authUser
 * @author Miguel Trevino
 */
const leaseConfirmation = async (data, authUser) => {
	const { network, coin, zelfName, confirmationData } = data;

	let inMainnet = false;

	const zelfNameRecords = await previewZelfName({ zelfName, environment: "both" }, authUser);

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

	const zelfName = zelfNameObject.preview?.publicData.zelfName || zelfNameObject.publicData.zelfName.replace(".hold", "");

	const payload = {
		base64: zelfNameObject.zelfProofQRCode,
		name: zelfName,
		metadata: {
			hasPassword: `${Boolean(zelfNameObject.preview?.passwordLayer === "Password") ||
				Boolean(zelfNameObject.hasPassword) ||
				zelfNameObject.publicData.hasPassword
				}`,
			zelfProof: zelfNameObject.publicData.zelfProof,
			zelfName,
			ethAddress: zelfNameObject.preview.publicData.ethAddress,
			solanaAddress: zelfNameObject.preview.publicData.solanaAddress,
			btcAddress: zelfNameObject.preview.publicData.btcAddress,
			extraParams: JSON.stringify({
				origin: zelfNameObject.preview.publicData.origin || "online",
				registeredAt: moment().format("YYYY-MM-DD HH:mm:ss"),
				expiresAt,
			}),
			type: "mainnet",
		},
		pinIt: true,
	};

	payload.metadata.expiresAt = expiresAt;

	const masterArweaveRecord = await ArweaveModule.zelfNameRegistration(zelfNameObject.zelfProofQRCode, {
		hasPassword: payload.metadata.hasPassword,
		zelfProof: payload.metadata.zelfProof,
		publicData: payload.metadata,
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
			arweaveId: masterArweaveRecord.id,
		})
		: "no_referral";

	reward = await addPurchaseReward({
		ethAddress: masterIPFSRecord.metadata.ethAddress,
		solanaAddress: masterIPFSRecord.metadata.solanaAddress,
		zelfName: masterIPFSRecord.metadata.zelfName,
		zelfNamePrice: zelfNameObject.publicData.price,
		ipfsHash: masterIPFSRecord.IpfsHash,
		arweaveId: masterArweaveRecord.id,
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
		masterIPFSRecord,
		reward,
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

const _findDuplicatedZelfName = async (zelfName, environment = "both", authUser, returnResults = false) => {
	const searchResult = await searchZelfName(
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

	const searchResult = await searchZelfName(
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
		let zelfNameObjects = await _findZelfName(
			{
				zelfName: params.zelfName,
				key: params.key,
				value: params.value,
			},
			params.environment,
			authUser
		);

		if (!Array.isArray(zelfNameObjects)) {
			zelfNameObjects = [zelfNameObjects];
		}

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
 * preview Zelf name
 * @param {String} zelfName
 * @param {Object} authUser
 */
const previewZelfProof = async (zelfProof, authUser) => {
	let zelfNameObject = await preview({ zelfProof });

	return zelfNameObject;
};

/**
 * preview with IPFS
 * @param {Object} params
 * @param {Object} authUser
 * @author Miguel Trevino
 */
const _previewWithIPFS = async (params, authUser) => {
	try {
		const searchResult = await _searchInIPFS(params.environment, params, { ...authUser, pro: true }, false);

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

	const searchResults = await searchZelfName(
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
		return inArweave ? searchResults.arweave : searchResults.ipfs || [];
	}

	return inArweave ? searchResults.arweave[0] : searchResults.ipfs[0];
};

/**
 * decrypt zelfName
 * @param {Object} params
 * @param {Object} authUser
 */
const decryptZelfName = async (params, authUser) => {
	const zelfNameObjects = await _findZelfName({ zelfName: params.zelfName }, "both", authUser); //ipfs or arweave [0]

	const zelfNameObject = zelfNameObjects[0]; // arweave[0] or ipfs[0] or othersource[0] or nostr[0]

	const { face, password } = await _decryptParams(params, authUser);

	const decryptedZelfProof = await decrypt({
		zelfProof: zelfNameObject.zelfProof || params.zelfProof,
		faceBase64: face,
		password,
		addServerPassword: Boolean(params.addServerPassword),
	});

	if (decryptedZelfProof.error) {
		const error = new Error(decryptedZelfProof.error.code);
		error.status = 409;
		throw error;
	}

	const { encryptedMessage, privateKey } = await SessionModule.walletEncrypt(
		decryptedZelfProof.metadata,
		zelfNameObject.publicData.ethAddress,
		password
	);

	return {
		...zelfNameObject,
		zelfName: zelfNameObject.publicData.zelfName,
		image: zelfNameObject.zelfProofQRCode,
		metadata: decryptedZelfProof.metadata, // once you implement it in znsv2, this has to be removed and only keep pgp.
		pgp: { encryptedMessage, privateKey },
		url: zelfNameObject.url,
		publicData: {
			...zelfNameObject.publicData,
			...decryptedZelfProof.publicData,
		},
	};
};

const leaseOffline = async (params, authUser) => {
	const { zelfName, duration, zelfProof, zelfProofQRCode, referralZelfName } = params;

	let mainnetRecord = null;
	let holdRecord = null;
	let zelfNameRecords = [];

	try {
		zelfNameRecords = await previewZelfName({ zelfName, environment: "both" }, authUser);
	} catch (exception) { }

	for (let index = 0; index < zelfNameRecords.length; index++) {
		const ipfsRecord = zelfNameRecords[index];

		if (ipfsRecord.publicData.type === "hold") holdRecord = ipfsRecord;

		if (ipfsRecord.publicData.type === "mainnet") mainnetRecord = ipfsRecord;
	}

	const _zelfProof = holdRecord?.publicData?.zelfProof || mainnetRecord?.publicData?.zelfProof;

	if (mainnetRecord) {
		const error = new Error("zelfName_purchased_already");
		error.status = 409;
		throw error;
	}

	let _preview = holdRecord?.preview || mainnetRecord?.preview;

	const { price, reward, priceWithoutDiscount } = ZNSPartsModule.calculateZelfNamePrice(zelfName.length - 5, duration, referralZelfName);

	if (!_preview) _preview = await preview({ zelfProof });

	const zelfNameObject = {
		zelfName,
		zelfProof,
		image: zelfProofQRCode,
		hasPassword: _preview.passwordLayer === "WithPassword" ? "true" : "false",
		price,
		reward,
	};

	if (!zelfName.includes(_preview.publicData.zelfName)) {
		const error = new Error("zelfName_does_not_match_in_zelfProof");
		error.status = 409;
		throw error;
	}

	if (_zelfProof && zelfProof !== _zelfProof) {
		const error = new Error("zelfProof_does_not_match_in_hold");
		error.status = 409;
		throw error;
	}

	if (holdRecord)
		return {
			existed: true,
			...holdRecord,
			hasPassword: Boolean(_preview.passwordLayer === "WithPassword"),
			zelfName,
			preview: _preview,
		};

	const referralZelfNameObject = await _validateReferral(referralZelfName, authUser);

	await _createPaymentCharge(zelfNameObject, { referralZelfName, referralZelfNameObject }, authUser);

	return {
		...zelfNameObject,
		hasPassword: Boolean(_preview.passwordLayer === "WithPassword"),
		durationToken: jwt.sign(
			{
				zelfName,
				exp: moment().add(12, "hour").unix(),
			},
			config.JWT_SECRET
		),
	};
};

/**
 * update zelfName
 * @param {Object} params
 * @param {Object} authUser
 */
const update = async (params, authUser) => {
	const { duration } = params;
	const { zelfName } = authUser;

	const zelfNameRecords = await previewZelfName({ zelfName, environment: "both" }, authUser);

	if (!zelfNameRecords.length) {
		const error = new Error("zelfName_not_found");
		error.status = 404;
		throw error;
	}

	const holdRecord = zelfNameRecords.find((record) => record.publicData.type === "hold");

	// check if holdDuration is == same as the duration passed on params
	if (holdRecord.publicData.duration === duration) {
		const error = new Error("hold_duration_is_the_same");
		error.status = 409;
		throw error;
	}

	if (!holdRecord) {
		const error = new Error("zelfName_not_found");
		error.status = 404;
		throw error;
	}

	const { ipfs_pin_hash, publicData } = holdRecord;

	const { price } = ZNSPartsModule.calculateZelfNamePrice(
		holdRecord.zelfName.split(".zelf")[0].length,
		duration,
		holdRecord.publicData.referralZelfName
	);

	holdRecord.price = price;

	const updatedRecord = await IPFSModule.update(
		ipfs_pin_hash,
		{
			base64: holdRecord.zelfProofQRCode,
			name: holdRecord.zelfName,
			metadata: {
				...publicData,
				price: `${holdRecord.price}`,
				duration,
			},
			pinIt: true,
		},
		{ ...authUser, pro: true }
	);

	return updatedRecord;
};

module.exports = {
	searchZelfName,
	leaseZelfName,
	leaseConfirmation,
	previewZelfName,
	previewZelfProof,
	decryptZelfName,
	leaseOffline,
	saveInProduction: _cloneZelfNameToProduction,
	update,
};
