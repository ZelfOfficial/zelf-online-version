const { createBTCWallet } = require("../../Wallet/modules/btc");
const { generateSuiWalletFromMnemonic } = require("../../Wallet/modules/sui");
const { createTonWallet } = require("../../Wallet/modules/ton");
const { createAptosWallet } = require("../../Wallet/modules/aptos");
const SessionModule = require("../../Session/modules/session.module");
const { parseLeaseDate } = require("../../Tags/modules/lease-date.util");
const IPFSModule = require("../../IPFS/modules/ipfs.module");
const ArweaveModule = require("../../Arweave/modules/arweave.module");

/**
 * initTagUpdates
 * @param {Object} zelfNameObject
 * @param {string} mnemonic
 * @returns {Object}
 * @author Miguel Trevino
 */
const initTagUpdates = async (zelfNameObject, secretKeys) => {
	const { mnemonic, zkProof, solanaSecretKey, password } = secretKeys;
	let sui = {};
	let btc = {};

	const tagsToAdd = [];

	if (!zelfNameObject.publicData.suiAddress) {
		sui = await generateSuiWalletFromMnemonic(mnemonic);

		zelfNameObject.publicData.suiAddress = sui.address;

		tagsToAdd.push({ name: "suiAddress", value: sui.address, new: true });
	}

	if (!zelfNameObject.publicData.tonAddress) {
		const ton = await createTonWallet(mnemonic);
		zelfNameObject.publicData.tonAddress = ton.address;
		tagsToAdd.push({ name: "tonAddress", value: ton.address, new: true });
	}

	if (!zelfNameObject.publicData.aptosAddress) {
		const aptos = await createAptosWallet(mnemonic);
		zelfNameObject.publicData.aptosAddress = aptos.address;
		tagsToAdd.push({ name: "aptosAddress", value: aptos.address, new: true });
	}

	if (!zelfNameObject.publicData.btcAddress.startsWith("bc1")) {
		btc = createBTCWallet(mnemonic);

		zelfNameObject.publicData.btcAddress = btc.address;

		tagsToAdd.push({ name: "btcAddress", value: btc.address, new: false });
	}

	const { encryptedMessage, privateKey } = await SessionModule.walletEncrypt(
		{ mnemonic, zkProof, solanaSecretKey, suiSecretKey: sui.secretKey },
		zelfNameObject.publicData.ethAddress,
		password
	);

	return {
		encryptedMessage,
		privateKey,
		tagsToAdd,
	};
};

const updateTags = async (zelfNameObject, tagsToAdd = []) => {
	if (!tagsToAdd.length || !zelfNameObject.zelfProofQRCode) return {};

	const extraParams = {
		origin: zelfNameObject.publicData.origin || "online",
		suiAddress: zelfNameObject.publicData.suiAddress,
		registeredAt: parseLeaseDate(zelfNameObject.publicData.registeredAt).add(30, "second").format("YYYY-MM-DD HH:mm:ss"),
		expiresAt: parseLeaseDate(zelfNameObject.publicData.expiresAt).add(30, "second").format("YYYY-MM-DD HH:mm:ss"),
	};

	if (zelfNameObject.publicData.price) {
		extraParams.price = zelfNameObject.publicData.price;
	}

	if (zelfNameObject.publicData.duration) {
		extraParams.duration = zelfNameObject.publicData.duration;
	}

	if (zelfNameObject.publicData.referralZelfNameObject) {
		extraParams.referralZelfName = zelfNameObject.publicData.referralZelfName;

		extraParams.referralSolanaAddress = zelfNameObject.publicData.referralSolanaAddress;
	}

	const metadata = {
		zelfProof: zelfNameObject.zelfProof,
		zelfName: zelfNameObject.publicData.zelfName,
		hasPassword: zelfNameObject.publicData.hasPassword,
		ethAddress: zelfNameObject.publicData.ethAddress,
		btcAddress: zelfNameObject.publicData.btcAddress,
		solanaAddress: zelfNameObject.publicData.solanaAddress,
		extraParams,
		type: zelfNameObject.publicData.type || (zelfNameObject.publicData.zelfName.includes("hold") ? "hold" : "mainnet"),
	};

	for (let index = 0; index < tagsToAdd.length; index++) {
		const tag = tagsToAdd[index];

		if (tag.name === "suiAddress") {
			metadata.extraParams.suiAddress = tag.value;

			continue;
		}

		metadata[tag.name] = tag.value;
	}

	metadata.extraParams = JSON.stringify(metadata.extraParams);

	let arweave = {};

	// unpin the current IPFS hash
	if (zelfNameObject.ipfsHash || zelfNameObject.ipfs_pin_hash) {
		await IPFSModule.unPinFiles([zelfNameObject.ipfsHash || zelfNameObject.ipfs_pin_hash]);
	}

	const ipfs = await IPFSModule.insert(
		{
			base64: zelfNameObject.zelfProofQRCode,
			name: zelfNameObject.zelfName,
			metadata,
			pinIt: true,
		},
		{ pro: true }
	);

	if (metadata.type === "mainnet") {
		// save in Arweave as well
		arweave = await ArweaveModule.zelfNameRegistration(zelfNameObject.zelfProofQRCode, {
			hasPassword: metadata.hasPassword,
			zelfProof: metadata.zelfProof,
			publicData: metadata,
		});
	}

	return {
		ipfs,
		arweave,
	};
};

module.exports = {
	initTagUpdates,
	updateTags,
};
