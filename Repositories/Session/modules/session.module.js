let armoredPublicKey = null;
let secretKey = "your-secret-key";
let passphrase = "something-seom";
const openpgp = require("openpgp");
const Model = require("../models/session.model");
const jwt = require("jsonwebtoken");
const config = require("../../../Core/config");
const PGPKeyModule = require("../../PGP/modules/pgp-keys.module");
const MongoORM = require("../../../Core/mongo-orm");
const moment = require("moment");
const { normalizeZelfName } = require("../../Tags/modules/zelf-name.util");
const populates = [];

/** Same 10-minute window as the session TTL (`activatedAt` expires after 600s). */
const IDENTITY_VERIFIED_WINDOW_MS = 10 * 60 * 1000;

/**
 * @param {*} params
 * @param {*} authUser
 */
const get = async (params, authUser = {}) => {
	const queryParams = {
		...params,
	};

	if (authUser.identifier) {
		queryParams.where_identifier = authUser.identifier;
	}

	if (authUser.type) {
		queryParams.where_type = authUser.type;
	}

	return await MongoORM.buildQuery(queryParams, Model, null, populates);
};

/**
 * @param {*} params
 */
const insert = async (params) => {
	const queryParams = {
		findOne: true,
	};

	queryParams.where_clientIP = params.clientIP;

	if (params.tagName) queryParams["?where_tagName"] = params.tagName;
	if (params.identifier) queryParams["?where_identifier"] = params.identifier;

	let existingSession = await get(queryParams);

	if (existingSession) {
		if (params.killSession) {
			try {
				await existingSession.deleteOne();
			} catch (_) {
				// session was already deleted by a concurrent request, which is fine
			}

			existingSession = null;
		} else {
			// A newly requested token must not inherit a previous face check.
			await Model.updateOne(
				{ _id: existingSession._id },
				{ $set: { verifiedTagName: null, verifiedAt: null, verifiedUntil: null } }
			);
			existingSession.verifiedTagName = null;
			existingSession.verifiedAt = null;
			existingSession.verifiedUntil = null;

			return {
				token: jwt.sign(
					{
						domain: existingSession.domain,
						ethAddress: existingSession.ethAddress,
						identifier: existingSession.identifier,
						ip: existingSession.clientIP,
						session: existingSession._id,
						tagName: existingSession.tagName,
					},
					config.JWT_SECRET
				),
				activatedAt: moment(existingSession.activatedAt).utc().unix(),
				expiresAt: moment(existingSession.activatedAt).utc().add(10, "minutes").unix(),
			};
		}
	}

	const session = new Model({
		clientIP: params.clientIP,
		domain: params.domain || "zelf",
		ethAddress: params.ethAddress || null,
		identifier: params.identifier || params.clientIP,
		isWebExtension: params.isWebExtension || false,
		status: "active",
		// Client tagName and type are stored for compatibility. They do not prove a face check.
		tagName: params.tagName || null,
		type: params.type || "general",
		verifiedTagName: null,
		verifiedAt: null,
		verifiedUntil: null,
	});

	try {
		await session.save();
	} catch (exception) {
		console.error({
			exception,
			identifier: params.clientIP,
			...session,
		});
	}

	return {
		token: jwt.sign(
			{
				domain: session.domain || "zelf",
				ethAddress: params.ethAddress || null,
				identifier: session.identifier,
				ip: session.clientIP,
				session: session._id,
				tagName: session.tagName || null,
			},
			config.JWT_SECRET
		),
		activatedAt: moment(session.activatedAt).utc().unix(),
		expiresAt: moment(session.activatedAt).utc().add(10, "minutes").unix(),
	};
};

const extractPublicKey = async (params) => {
	// Use unique identifier (wallet + device hash) for better user experience
	// Fallback to clientIP for legacy support or if identifier not provided
	const identifier = params.identifier || params.clientIP;

	const storedKey = await PGPKeyModule.findSessionKey(identifier);

	if (storedKey) return storedKey.publicKey;

	const pgpRecord = await PGPKeyModule.generateKey("session", identifier, params.name, params.email, params.password);

	return pgpRecord.publicKey;
};

/**
 *
 * @param {*} params
 */
const getPublicKey = async (params) => {
	const { privateKey, publicKey } = await openpgp.generateKey({
		type: "ecc", // Type of the key, e.g., 'ecc' (Elliptic Curve)
		curve: "curve25519", // Curve to use for ECC
		userIDs: [{ name: params.name || "Wallet", email: params.email || "wallet@zelf.world" }],
		passphrase,
	});

	secretKey = privateKey;

	armoredPublicKey = publicKey;

	return { publicKey, params };
};

const decryptContent = async (params, identifier) => {
	const { message: encryptedMessage } = params;

	try {
		const privateKey = await openpgp.readPrivateKey({ armoredKey: secretKey });

		const decryptedPrivateKey = await openpgp.decryptKey({
			privateKey,
			passphrase,
		});

		// Read the encrypted message
		const message = await openpgp.readMessage({
			armoredMessage: encryptedMessage,
		});

		// Decrypt the message
		const { data: decrypted } = await openpgp.decrypt({
			message,
			decryptionKeys: decryptedPrivateKey,
		});

		return decrypted;
	} catch (error) {
		console.error("Error during decryption:", { error });

		throw new Error("decryption_failed");
	}
};

const encryptContent = async (message) => {
	if (!armoredPublicKey) return null;

	const publicKey = await openpgp.readKey({ armoredKey: armoredPublicKey });

	// Encrypt the message
	const encryptedMessage = await openpgp.encrypt({
		message: await openpgp.createMessage({ text: JSON.stringify(message) }),
		encryptionKeys: publicKey,
	});

	return encryptedMessage;
};

const _getPrivateKey = async (authUser) => {
	const pgpRecord = await PGPKeyModule.findSessionKey(null, authUser);

	if (!pgpRecord) throw new Error("key_not_found");

	const privateKey = await PGPKeyModule.decryptKey(pgpRecord.type, pgpRecord.key);

	return privateKey;
};

const sessionDecrypt = async (content, authUser) => {
	if (!content) return null;

	let privateKey = null;
	try {
		privateKey = await _getPrivateKey(authUser);

		const decryptedContent = await PGPKeyModule.decryptContent("session", privateKey, content);

		return decryptedContent;
	} catch (exception) {
		console.error("Error during decryption:", { exception, authUser });
		// Use the format "statusCode:message" that errorHandler expects
		const error = new Error("412:encryption_key_didnt_match");

		throw error;
	}
};

const PGP_MESSAGE_HEADER = "-----BEGIN PGP MESSAGE-----";

/** True when the value is an armored PGP message (what the extension sends). */
const isPGPMessage = (value) => typeof value === "string" && value.trimStart().startsWith(PGP_MESSAGE_HEADER);

/**
 * Single-field rule for client secrets: PGP-decrypt with the session key when armored, otherwise plaintext as sent.
 * @param {string|null|undefined} value
 * @param {Object} authUser
 */
const decryptIfPGP = async (value, authUser) => {
	if (value === undefined || value === null || value === "") return null;
	return isPGPMessage(value) ? module.exports.sessionDecrypt(value, authUser) : value;
};

const walletEncrypt = async (content, walletScopeKey, password = "", legacyIdentifier = null) => {
	let pgpRecord = await PGPKeyModule.findStorageKey({ scopeKey: walletScopeKey, legacyIdentifier });
	const shouldRotateStorageKey = Boolean(password);

	const payload = {
		publicKey: pgpRecord?.publicKey,
		privateKey: null,
		new: false,
	};

	if (!pgpRecord || shouldRotateStorageKey) {
		await _generateNewWalletKeys(walletScopeKey, payload, password, legacyIdentifier);
	} else {
		payload.privateKey = await PGPKeyModule.decryptKey(pgpRecord.type, pgpRecord.key);
	}

	const publicKey = await openpgp.readKey({
		armoredKey: payload.publicKey,
	});

	// Encrypt the message
	const encryptedMessage = await openpgp.encrypt({
		message: await openpgp.createMessage({ text: typeof content === "string" ? content : JSON.stringify(content) }),
		encryptionKeys: publicKey,
	});

	return { encryptedMessage, privateKey: payload.privateKey };
};

const _generateNewWalletKeys = async (walletScopeKey, walletData, password, legacyIdentifier = null) => {
	const newPgpRecord = await PGPKeyModule.generateKey("storage", legacyIdentifier || walletScopeKey, null, null, password, {
		scopeType: "wallet",
		scopeKey: walletScopeKey,
	});

	walletData.publicKey = newPgpRecord.publicKey;
	walletData.privateKey = newPgpRecord.privateKey;
	walletData.new = true;
};

const walletDecrypt = async (content, walletScopeKey, password, legacyIdentifier = null) => {
	try {
		const pgpRecord = await PGPKeyModule.findStorageKey({ scopeKey: walletScopeKey, legacyIdentifier });

		if (!pgpRecord) throw new Error("key_not_found");

		const _privateKey = await PGPKeyModule.decryptKey(pgpRecord.type, pgpRecord.key);

		const privateKey = await openpgp.readPrivateKey({ armoredKey: _privateKey });

		const decryptedPrivateKey = await openpgp.decryptKey({
			privateKey,
			passphrase: password,
		});

		// Read the encrypted message
		const message = await openpgp.readMessage({
			armoredMessage: content,
		});

		// Decrypt the message
		const { data: decrypted } = await openpgp.decrypt({
			message,
			decryptionKeys: decryptedPrivateKey,
		});

		return decrypted;
	} catch (error) {
		console.error("Error during decryption:", { error });

		throw new Error("decryption_failed");
	}
};

/**
 * delete session
 * @param {Object} authUser
 * @author Miguel Trevino
 */
const deleteSession = async (authUser) => {
	return await Model.deleteMany({ identifier: authUser.identifier });
};

/**
 * Stamp the current session after a successful face check (and master password when the wallet has one).
 * The name stored is the normalized tag, not whatever the client sent at session create.
 * @param {Object} authUser
 * @param {string} tagName
 * @param {string} [domain]
 */
const markSessionIdentityVerified = async (authUser, tagName, domain) => {
	if (!authUser?.session) return null;

	const normalized = normalizeZelfName(tagName, domain || authUser.domain || "zelf");
	if (!normalized.zelfName) return null;

	const verifiedAt = new Date();
	const verifiedUntil = new Date(verifiedAt.getTime() + IDENTITY_VERIFIED_WINDOW_MS);

	await Model.updateOne(
		{ _id: authUser.session },
		{
			$set: {
				verifiedTagName: normalized.zelfName,
				verifiedAt,
				verifiedUntil,
			},
		}
	);

	return { ...normalized, verifiedAt, verifiedUntil };
};

module.exports = {
	get,
	insert,
	getPublicKey,
	decryptContent,
	encryptContent,
	extractPublicKey,
	sessionDecrypt,
	decryptIfPGP,
	isPGPMessage,
	walletEncrypt,
	walletDecrypt,
	deleteSession,
	markSessionIdentityVerified,
	IDENTITY_VERIFIED_WINDOW_MS,
	normalizeZelfName,
};
