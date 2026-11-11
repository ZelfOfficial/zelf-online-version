const IPFS = require("../../../Core/ipfs");

const config = require("../../../Core/config");
const { filterOwnedRecords } = require("./ipfs-access.util");

const get = async (data, authUser, options = {}) => {
	const { cid, zelfName, key, value, exipres } = data;

	if (cid) return await IPFS.retrieve(cid, expires);

	if (zelfName) return await IPFS.filter("name", zelfName);

	if (key && value) {
		const records = await IPFS.filter(key, value);
		if (options.restrictToCaller) return filterOwnedRecords(records, authUser);
		return records;
	}

	const error = new Error("Conditions_not_acceptable");

	error.status = 412;

	throw error;
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
		coinbase_hosted_url: metadata.coinbase_hosted_url,
	});
};

module.exports = {
	get,
	show,
	insert,
	unPinFiles,
	update,
};
