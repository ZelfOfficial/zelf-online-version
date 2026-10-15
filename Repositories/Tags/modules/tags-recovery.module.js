const TagsModule = require("./tags.module");
const TagsPartsModule = require("./tags-parts.module");
const SessionModule = require("../../Session/modules/session.module");
const { decrypt } = require("../../ZelfProof/modules/zelf-proof.module");
const { effectivePassword } = require("../../ZelfID/modules/zelf-id-password.module");
const { getDomainConfig } = require("../config/supported-domains");
const TagsRegistrationModule = require("./tags-registration.module");

/**
 * Lease recovery for Tags
 * @param {Object} payload
 * @param {Object} authUser
 * @author Miguel Trevino
 */
const leaseRecovery = async (payload, authUser) => {
	const { zelfProof, tagName, domain, type, os, addServerPassword, referralTagName } = payload;

	const duration = payload.duration || 1;

	const domainConfig = getDomainConfig(domain);

	// try to find if that zelfProof is already inside a record
	const zelfProofRecord = await TagsModule.searchTag({ key: "zelfProof", value: zelfProof, domain, domainConfig }, authUser);

	if (zelfProofRecord?.tagObject) {
		return { ...zelfProofRecord.tagObject, message: "Zelf Proof found and is being used by another tag" };
	}

	await TagsModule._findDuplicatedTag(tagName, domain, domainConfig);

	const { face, password: rawPassword } = await TagsPartsModule.decryptParams(payload, authUser);

	// Face-only: no password (clients send the placeholder), same as tags/decrypt and zelf-ids recovery.
	const password = effectivePassword({ password: rawPassword, securityType: payload.securityType });

	// Same SenseCrypt stack as tags/decrypt: v4 opens tags/lease and zelf-ids/lease proofs alike
	// (the legacy stack failed v4 proofs with ERR_PARSE_FAILED).
	const decryptedZelfProof = await decrypt({
		addServerPassword: Boolean(addServerPassword),
		faceBase64: face,
		password,
		zelfProof,
		os: os || "DESKTOP",
		stack: "v4",
	});

	const referralTagObject = await TagsModule._validateReferral(referralTagName, authUser, domainConfig);

	const { eth, btc, solana, sui, stellar, polkadot, kusama, ton, aptos, zkProof, mnemonic, arweave } = await TagsModule._createWalletsFromPhrase({
		faceBase64: face,
		password,
		type: "import",
		mnemonic: decryptedZelfProof.metadata.mnemonic,
	});

	const tagKey = domainConfig.getTagKey();

	const dataToEncrypt = {
		publicData: {
			ethAddress: eth.address,
			solanaAddress: solana.address,
			btcAddress: btc.address,
			stellarAddress: stellar.address,
			[tagKey]: tagName,
			domain: domain,
		},
		metadata: {
			mnemonic,
			solanaSecretKey: solana.secretKey,
		},
		faceBase64: face,
		password,
		_id: tagName,
		tolerance: payload.tolerance,
		addServerPassword: Boolean(payload.addServerPassword),
	};

	const tagObject = {
		...dataToEncrypt.publicData,
		duration,
	};

	const skipZelfProof = decryptedZelfProof.publicData[tagKey] === tagName;

	TagsPartsModule.assignProperties(tagObject, dataToEncrypt, { eth, btc, solana, sui, stellar, arweave, polkadot, kusama, ton, aptos }, { ...payload, password, referralTagObject }, domainConfig);

	await TagsPartsModule.generateZelfProof(dataToEncrypt, tagObject, decryptedZelfProof.publicData[tagKey] === tagName, false);

	tagObject.zelfProof = skipZelfProof ? zelfProof : tagObject.zelfProof;

	const securityType = password ? (/^\d{6}$/.test(password) ? "pin" : "password") : null;

	if (tagObject.price === 0) {
		await TagsRegistrationModule.confirmFreeTag(tagObject, referralTagObject, domainConfig, securityType, authUser);
	} else {
		await TagsRegistrationModule.saveHoldTagInIPFS(tagObject, referralTagObject, domainConfig, securityType, authUser);
	}

	const pgp = await TagsPartsModule.generatePGPKeys(dataToEncrypt, { eth, btc, solana, sui, stellar, arweave, polkadot, kusama, ton, aptos }, password);

	return {
		ipfs: [tagObject.ipfs],
		available: false,
		name: tagName,
		tagName: `${tagName}.${domain}`,
		domain,
		arweave: tagObject.arweave ? [tagObject.arweave] : [],
		tagObject: {
			...tagObject.ipfs,
			zelfProof: tagObject.zelfProof,
			zelfProofQRCode: tagObject.zelfProofQRCode,
		},
		pgp,
	};
};

const _generatePGPKeys = async (dataToEncrypt, addresses, password) => {
	const { eth, solana, sui } = addresses;

	let encryptedMessage;
	let privateKey;

	const pgpKeys = await SessionModule.walletEncrypt(
		{
			mnemonic: dataToEncrypt.metadata.mnemonic,
			zkProof: dataToEncrypt.metadata.zkProof,
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

module.exports = {
	leaseRecovery,
};
