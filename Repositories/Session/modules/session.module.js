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
 * Fields a client must not be able to write onto a session.
 * Verification is stamped later from the stored record.
 */
const CLIENT_IDENTITY_FIELDS = ["tagName", "verifiedTagName", "zelfName", "identity", "verifiedAt", "verifiedUntil"];

/**
 * Document fields for a new session. Client identity claims are ignored.
 * @param {Object} params
 */
const newSessionDocument = (params) => ({
	clientIP: params.clientIP,
	domain: params.domain || "zelf",
	ethAddress: params.ethAddress || null,
	identifier: params.identifier || params.clientIP,
	isWebExtension: params.isWebExtension || false,
	status: "active",
	tagName: null,
	type: params.type || "general",
	verifiedTagName: null,
	verifiedAt: null,
	verifiedUntil: null,
});

/**
 * Claims placed on the session JWT. Identity fields are never copied from the client or from an older document.
 * @param {Object} session
 * @param {string|null} ethAddress
 */
const sessionJwtClaims = (session, ethAddress) => ({
	domain: session.domain || "zelf",
	ethAddress: ethAddress || null,
	identifier: session.identifier,
	ip: session.clientIP,
	session: session._id,
});

/**
 * Seconds until the session document expires, so the JWT dies with that session.
 * A brand-new session is 10 minutes. A reused session gets only the time it has left.
 * @param {Date|string|number} activatedAt
 * @param {Date} [now]
 * @returns {number}
 */
const sessionJwtExpiresInSeconds = (activatedAt, now = new Date()) => {
	const expiresAt = moment(activatedAt).utc().add(10, "minutes").unix();
	const nowUnix = moment(now).utc().unix();
	return Math.max(1, expiresAt - nowUnix);
};

const signSessionToken = (session, ethAddress) =>
	jwt.sign(sessionJwtClaims(session, ethAddress), config.JWT_SECRET, {
		expiresIn: sessionJwtExpiresInSeconds(session.activatedAt),
	});

const sessionTokenResponse = (session, ethAddress) => ({
	token: signSessionToken(session, ethAddress),
	activatedAt: moment(session.activatedAt).utc().unix(),
	expiresAt: moment(session.activatedAt).utc().add(10, "minutes").unix(),
});

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

	// tagName / verifiedTagName / zelfName / identity are not lookup keys.
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
			return sessionTokenResponse(existingSession, existingSession.ethAddress || null);
		}
	}

	const session = new Model(newSessionDocument(params));

	try {
		await session.save();
	} catch (exception) {
		console.error({
			exception,
			identifier: params.clientIP,
			...session,
		});
	}

	return sessionTokenResponse(session, params.ethAddress || null);
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

const nameOnRecord = (record) => {
	const publicData = record?.publicData || {};
	if (typeof publicData.zelfName === "string" && publicData.zelfName.trim()) return publicData.zelfName.trim();
	if (typeof publicData.tagName === "string" && publicData.tagName.trim()) return publicData.tagName.trim();
	return "";
};

const namedError = (status, code) => {
	const error = new Error(`${status}:${code}`);
	error.status = status;
	error.code = code;
	error.clientCode = code;
	return error;
};

const zelfNameMismatch = () => namedError(403, "ZELF_NAME_MISMATCH");

const zelfProofMismatch = () => namedError(403, "ZELF_PROOF_MISMATCH");

/**
 * Byte-compare two zelfProof strings. Both values are public records, not secrets.
 * @param {string} clientProof
 * @param {string} storedProof
 * @returns {boolean}
 */
const proofsMatch = (clientProof, storedProof) => {
	if (typeof clientProof !== "string" || typeof storedProof !== "string") return false;
	const left = clientProof.trim();
	const right = storedProof.trim();
	if (!left || !right || left.length !== right.length) return false;
	return Buffer.from(left).equals(Buffer.from(right));
};

/**
 * Reject when the caller sent a name that is not the name on the decrypted or stored record.
 * An empty requested name is not a claim.
 * @param {string} requestedName
 * @param {string} recordName
 * @param {string} [domain]
 */
const assertRequestedMatchesRecord = (requestedName, recordName, domain) => {
	if (requestedName == null || String(requestedName).trim() === "") return;
	const requested = normalizeZelfName(requestedName, domain || "zelf");
	const actual = normalizeZelfName(recordName, domain || "zelf");
	if (!actual.zelfName || requested.zelfName !== actual.zelfName) {
		throw zelfNameMismatch();
	}
};

/**
 * Reject when a candidate name is present and is not the stored record's name.
 * An empty candidate is not a claim.
 * @param {string} candidateName
 * @param {string} storedName
 * @param {string} [domain]
 */
const assertAgreesWithStoredName = (candidateName, storedName, domain) => {
	if (candidateName == null || String(candidateName).trim() === "") return;
	const candidate = normalizeZelfName(candidateName, domain || "zelf");
	const stored = normalizeZelfName(storedName, domain || "zelf");
	if (!stored.zelfName || candidate.zelfName !== stored.zelfName) {
		throw zelfNameMismatch();
	}
};

/**
 * Reject when the caller sent a blob that is not the stored zelfProof.
 * @param {string} clientProof
 * @param {string} storedProof
 */
const assertProofMatchesStored = (clientProof, storedProof) => {
	if (!storedProof) return;
	if (clientProof == null || String(clientProof).trim() === "") return;
	if (!proofsMatch(clientProof, storedProof)) {
		throw zelfProofMismatch();
	}
};

/**
 * Name to stamp, or null when no stored record can be confirmed.
 * Throws ZELF_NAME_MISMATCH or ZELF_PROOF_MISMATCH. Callers must not stamp after a throw.
 * The returned name is the stored record's zelfName.
 * @param {{ stored?: { zelfName?: string, zelfProof?: string }, requestedName?: string, decryptedName?: string, clientProof?: string, domain?: string }} input
 * @returns {string|null}
 */
const resolveVerificationStamp = ({ stored, requestedName, decryptedName, clientProof, domain }) => {
	const resolvedDomain = domain || "zelf";

	if (stored?.zelfName && stored?.zelfProof) {
		assertAgreesWithStoredName(requestedName, stored.zelfName, resolvedDomain);
		assertAgreesWithStoredName(decryptedName, stored.zelfName, resolvedDomain);
		assertProofMatchesStored(clientProof, stored.zelfProof);
		return stored.zelfName;
	}

	if (decryptedName != null && String(decryptedName).trim() !== "") {
		assertRequestedMatchesRecord(requestedName, decryptedName, resolvedDomain);
	}

	return null;
};

/**
 * Stamp verifiedTagName from a stored record name only.
 * A requested or decrypted name that does not match that record is rejected and nothing is stamped.
 * @param {Object} authUser
 * @param {string} storedName
 * @param {{ requestedName?: string, decryptedName?: string, domain?: string }} [options]
 */
const stampVerifiedFromStoredName = async (authUser, storedName, options = {}) => {
	const domain = options.domain || authUser?.domain || "zelf";
	assertAgreesWithStoredName(options.requestedName, storedName, domain);
	assertAgreesWithStoredName(options.decryptedName, storedName, domain);
	return markSessionIdentityVerified(authUser, storedName, domain);
};

/**
 * Stamp the current session after a decrypt of the stored record.
 * The name stored is the normalized tag taken from that record, not from the client.
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

/**
 * Verified name for this session, or null when the session was not stamped from a stored record.
 * JWT claims are ignored.
 * @param {Object} authUser
 * @returns {Promise<string|null>}
 */
const readVerifiedTagName = async (authUser) => {
	if (!authUser?.session) return null;

	const session = await Model.findById(authUser.session).select("verifiedTagName verifiedUntil").lean();
	if (!session?.verifiedTagName || !session.verifiedUntil) return null;
	if (new Date(session.verifiedUntil).getTime() <= Date.now()) return null;

	return String(session.verifiedTagName).trim().toLowerCase();
};

module.exports = {
	get,
	insert,
	getPublicKey,
	decryptContent,
	encryptContent,
	extractPublicKey,
	sessionDecrypt,
	walletEncrypt,
	walletDecrypt,
	deleteSession,
	CLIENT_IDENTITY_FIELDS,
	IDENTITY_VERIFIED_WINDOW_MS,
	newSessionDocument,
	sessionJwtClaims,
	sessionJwtExpiresInSeconds,
	nameOnRecord,
	proofsMatch,
	assertRequestedMatchesRecord,
	assertAgreesWithStoredName,
	assertProofMatchesStored,
	resolveVerificationStamp,
	stampVerifiedFromStoredName,
	markSessionIdentityVerified,
	readVerifiedTagName,
	normalizeZelfName,
	zelfNameMismatch,
	zelfProofMismatch,
};
