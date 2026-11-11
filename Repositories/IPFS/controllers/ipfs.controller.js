const Module = require("../modules/ipfs.module");
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

const get = async (ctx) => {
	try {
		const query = ctx.request.query || {};
		const result = await Module.get(query);
		// Owner check belongs on this HTTP route only. IPFSModule.get is also used by
		// ZNS, tags, zelf-ids, renewals, and payments, which must see records they do not own.
		const data = query.cid ? result : restrictSearchToCaller(result, ctx.state?.user);

		ctx.body = { data };
	} catch (error) {
		console.error(error);
		ctx.status = error.status || 500;

		ctx.body = { error: error.message };
	}
};

/**
 * show a single IPFS via cid
 * @param {Object} ctx
 * @author Miguel Trevino
 */
const show = async (ctx) => {
	try {
		const data = await Module.show(ctx.request.params, ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		ctx.status = error.status || 500;

		ctx.body = { error: error.message };
	}
};

/**
 * upload an IPFS file - i.e a wallet in base64 qrCode
 * @param {Object} ctx
 */
const create = async (ctx) => {
	try {
		const data = await Module.insert(ctx.request.body, ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		console.error({ error });

		ctx.status = error.status || 500;

		ctx.body = { error: error.message };
	}
};

const destroy = async (ctx) => {
	try {
		const data = await Module.destroy(ctx.request.params, ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		console.error({ error });

		ctx.status = error.status || 500;

		ctx.body = { error: error.message };
	}
};

module.exports = {
	get,
	show,
	create,
	destroy,
};
