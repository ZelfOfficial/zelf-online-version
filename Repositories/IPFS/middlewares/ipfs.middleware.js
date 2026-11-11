const { string, validate, boolean, number } = require("../../../Core/JoiUtils");

const schemas = {
	upload: {
		base64: string().required(),
		name: string().required(),
	},
};

const rejectParam = (ctx, code, param) => {
	ctx.status = 400;
	ctx.body = param ? { error: code, code, param } : { error: code, code };
};

/**
 * Query values are strings when present. Arrays (repeated keys) and other types are rejected.
 * Empty string is treated as absent, matching the module's truthy checks.
 */
const readQueryString = (value) => {
	if (value === undefined || value === null || value === "") return { present: false };
	if (typeof value !== "string") return { invalid: true };
	return { present: true, value };
};

/**
 * Get Validation
 * @param {*} request
 * @param {*} response
 * @param {*} next
 */
const getValidation = async (ctx, next) => {
	const { clientId } = ctx.state.user;

	if (!clientId) {
		ctx.status = 409;

		ctx.body = { validationError: "Access forbidden. contact us for a valid API Key" };

		return;
	}

	const query = ctx.request.query || {};
	const cid = readQueryString(query.cid);
	const zelfName = readQueryString(query.zelfName);
	const key = readQueryString(query.key);
	const value = readQueryString(query.value);

	if (cid.invalid) return rejectParam(ctx, "INVALID_PARAM", "cid");
	if (zelfName.invalid) return rejectParam(ctx, "INVALID_PARAM", "zelfName");
	if (key.invalid) return rejectParam(ctx, "INVALID_PARAM", "key");
	if (value.invalid) return rejectParam(ctx, "INVALID_PARAM", "value");

	// cid or zelfName is enough on its own. key and value are only required together when neither is set.
	if (!cid.present && !zelfName.present) {
		if (key.present !== value.present) {
			return rejectParam(ctx, "MISSING_REQUIRED_PARAM", key.present ? "value" : "key");
		}

		if (!key.present) return rejectParam(ctx, "MISSING_REQUIRED_PARAM");
	}

	await next();
};

/**
 * Create Validation
 * @param {*} request
 * @param {*} response
 * @param {*} next
 */
const createValidation = async (ctx, next) => {
	const valid = validate(schemas.upload, ctx.request.body);

	if (valid.error) {
		ctx.status = 409;

		ctx.body = { validationError: valid.error.message };

		return;
	}

	const { clientId } = ctx.state.user;

	if (!clientId) {
		ctx.status = 409;

		ctx.body = { validationError: "Access forbidden. contact us for a valid API Key" };

		return;
	}

	await next();
};

const deleteValidation = async (ctx, next) => {
	const { clientId } = ctx.state.user;

	if (!clientId) {
		ctx.status = 409;

		ctx.body = { validationError: "Access forbidden. contact us for a valid API Key" };

		return;
	}

	await next();
};

const showValidation = async (ctx, next) => {
	const { clientId } = ctx.state.user;

	if (!clientId) {
		ctx.status = 409;

		ctx.body = { validationError: "Access forbidden. contact us for a valid API Key" };

		return;
	}

	const cid = ctx.params ? ctx.params.cid : undefined;

	if (cid === undefined || cid === null || cid === "") return rejectParam(ctx, "MISSING_REQUIRED_PARAM", "cid");
	if (typeof cid !== "string") return rejectParam(ctx, "INVALID_PARAM", "cid");

	await next();
};

module.exports = {
	getValidation,
	createValidation,
	deleteValidation,
	showValidation,
};
