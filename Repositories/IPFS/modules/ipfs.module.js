const IPFS = require("../../../Core/ipfs");

const config = require("../../../Core/config");
const { TOKEN_TYPES } = require("../../../Core/jwt-claims");

const isSuperAdminUser = (authUser) => Boolean(authUser) && (authUser.typ === TOKEN_TYPES.superAdmin || authUser.superAdminId);

const callerIdentityValues = (authUser) => {
	const keys = ["email", "staffEmail", "phone", "staffPhone", "identifier", "tagName", "ethAddress", "solanaAddress", "walletAddress", "clientId"];
	const values = new Set();

	for (const key of keys) {
		const raw = authUser?.[key];
		if (typeof raw === "string" && raw.trim()) values.add(raw.trim().toLowerCase());
	}

	return values;
};

const recordMatchesCaller = (record, identities) => {
	if (!identities.size || !record || typeof record !== "object") return false;

	const publicData = record.publicData || record.metadata?.keyvalues || record.keyvalues || {};
	const candidates = [];

	if (typeof record.name === "string") candidates.push(record.name);

	if (publicData && typeof publicData === "object") {
		for (const value of Object.values(publicData)) {
			if (value == null || typeof value === "object") continue;
			candidates.push(String(value));
		}
	}

	return candidates.some((value) => {
		const normalized = String(value).trim().toLowerCase();
		if (!normalized) return false;
		if (identities.has(normalized)) return true;

		for (const identity of identities) {
			if (identity.includes("@") && normalized.includes(identity)) return true;
		}

		return false;
	});
};

const restrictSearchToCaller = (result, authUser) => {
	if (!authUser || isSuperAdminUser(authUser)) return result;

	const identities = callerIdentityValues(authUser);
	if (Array.isArray(result)) return result.filter((record) => recordMatchesCaller(record, identities));

	return [];
};

const get = async (data, authUser) => {
	const { cid, zelfName, key, value, exipres } = data;

	if (cid) return await IPFS.retrieve(cid, expires);

	const filterOptions = {};

	if (data.limit) filterOptions.limit = data.limit;

	// Default filter() turns a Pinata failure into []. Callers that must retry (Stripe webhooks)
	// pass throwOnError so an outage is not reported as "no such record".
	if (data.throwOnError) filterOptions.throwOnError = true;

	let result;

	if (zelfName) result = await IPFS.filter("name", zelfName, filterOptions);
	else if (key && value) result = await IPFS.filter(key, value, filterOptions);
	else {
		const error = new Error("Conditions_not_acceptable");

		error.status = 412;

		throw error;
	}

	if (authUser && !isSuperAdminUser(authUser)) return restrictSearchToCaller(result, authUser);

	return result;
};

const show = async (data, authUser) => {
	const { cid } = data;

	try {
		const file = await IPFS.retrieve(cid);

		return file;
	} catch (exception) {
		const error = new Error("file_not_found");

		error.status = 404;

		throw error;
	}
};

const insert = async (data, authUser) => {
	const { base64, metadata, name, pinIt } = data;

	if ((authUser.pro || config.env === "development") && pinIt) return await IPFS.pinFile(base64, name, null, metadata);

	return await IPFS.upload(base64, name, null, metadata);
};

const unPinFiles = async (ids = []) => {
	try {
		const unpinnedFiles = await IPFS.deleteFiles(ids);

		return unpinnedFiles;
	} catch (exception) {}

	return null;
};

const update = async (previousIpfsPinHash, data, authUser) => {
	//unpin previous file
	await IPFS.deleteFiles([previousIpfsPinHash]);

	const { base64, metadata, name } = data;

	return await IPFS.pinFile(base64, name, null, {
		zelfName: metadata.zelfName,
		type: metadata.type,
		price: metadata.price, // this has to be updated based on the name and duration
		duration: metadata.duration,
		expiresAt: metadata.expiresAt,
		zelfProof: metadata.zelfProof,
		referralZelfName: metadata.referralZelfName,
		referralSolanaAddress: metadata.referralSolanaAddress,
	});
};

module.exports = {
	get,
	show,
	insert,
	unPinFiles,
	update,
};
