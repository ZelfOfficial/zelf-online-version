const crypto = require("crypto");
const { string, validate, boolean, number, stringEnum } = require("../../../Core/JoiUtils");
const configuration = require("../../../Core/config");
const { assertSuperAdminOtpRateLimit } = require("../modules/super-admin-otp-rate-limit.module");

const rejectOtpRateLimit = (ctx, error) => {
	ctx.status = error.status || 429;
	ctx.body = { error: error.code || "OTP_RATE_LIMITED", code: error.code || "OTP_RATE_LIMITED" };
	if (error.retryAfterSeconds) ctx.set("Retry-After", String(error.retryAfterSeconds));
};

const hasValidSuperAdminSecret = (ctx) => {
	const configured = typeof configuration.SUPERADMIN_JWT_SECRET === "string" ? configuration.SUPERADMIN_JWT_SECRET.trim() : "";
	if (!configured || configured === "your-secret-here") return false;

	const rawHeader = ctx.headers?.["x-api-key"] ?? ctx.header?.["x-api-key"];
	const apiKey = typeof rawHeader === "string" ? rawHeader.trim() : "";
	if (!apiKey) return false;

	const expectedBuf = Buffer.from(configured, "utf8");
	const actualBuf = Buffer.from(apiKey, "utf8");
	if (expectedBuf.length !== actualBuf.length) return false;

	return crypto.timingSafeEqual(expectedBuf, actualBuf);
};

const schemas = {
	get: {},
	show: {},
	create: {
		name: string().required(),
		countryCode: string().required(),
		phone: string().required(),
		email: string().required(),
		language: stringEnum(["en", "es"]),
		role: stringEnum(["super_admin", "blog"]),
	},
	update: {},
	destroy: {},
	auth: {
		email: string().required(),
		role: stringEnum(["super_admin", "blog"]),
		scope: stringEnum(["super_admin", "blog"]),
	},
	requestOtp: {
		email: string().required(),
	},
	verifyOtp: {
		email: string().required(),
		code: string().required(),
		role: stringEnum(["super_admin", "blog"]),
		scope: stringEnum(["super_admin", "blog"]),
	},
};

const getValidation = async (ctx, next) => {
	if (!hasValidSuperAdminSecret(ctx)) {
		ctx.status = 403;

		ctx.body = { validationError: "ApiKey not valid", code: "SUPER_ADMIN_SECRET_REQUIRED" };

		return;
	}

	const valid = validate(schemas.get, ctx.request.params);

	if (valid.error) {
		ctx.status = 409;

		ctx.body = { validationError: valid.error.message };

		return;
	}

	await next();
};

const showValidation = async (ctx, next) => {
	if (!hasValidSuperAdminSecret(ctx)) {
		ctx.status = 403;

		ctx.body = { validationError: "ApiKey not valid", code: "SUPER_ADMIN_SECRET_REQUIRED" };

		return;
	}

	const valid = validate(schemas.show, ctx.request.body);

	if (valid.error) {
		ctx.status = 409;

		ctx.body = { validationError: valid.error.message };

		return;
	}

	await next();
};

const createValidation = async (ctx, next) => {
	if (!hasValidSuperAdminSecret(ctx)) {
		ctx.status = 403;

		ctx.body = { validationError: "ApiKey not valid", code: "SUPER_ADMIN_SECRET_REQUIRED" };

		return;
	}

	const valid = validate(schemas.create, ctx.request.body);

	if (valid.error) {
		ctx.status = 409;

		ctx.body = { validationError: valid.error.message };

		return;
	}

	await next();
};

const destroyValidation = async (ctx, next) => {
	if (!hasValidSuperAdminSecret(ctx)) {
		ctx.status = 403;

		ctx.body = { validationError: "ApiKey not valid", code: "SUPER_ADMIN_SECRET_REQUIRED" };

		return;
	}

	const valid = validate(schemas.destroy, ctx.request.body);

	if (valid.error) {
		ctx.status = 409;

		ctx.body = { validationError: valid.error.message };

		return;
	}

	await next();
};

const updateValidation = async (ctx, next) => {
	if (!hasValidSuperAdminSecret(ctx)) {
		ctx.status = 403;

		ctx.body = { validationError: "ApiKey not valid", code: "SUPER_ADMIN_SECRET_REQUIRED" };

		return;
	}

	const valid = validate(schemas.update, ctx.request.body);

	if (valid.error) {
		ctx.status = 409;

		ctx.body = { validationError: valid.error.message };

		return;
	}

	await next();
};

const authValidation = async (ctx, next) => {
	const apiKey = ctx.headers["x-api-key"];

	if (!apiKey) {
		ctx.status = 403;

		ctx.body = { validationError: "Missing key" };

		return;
	}

	const valid = validate(schemas.auth, ctx.request.body);

	if (valid.error) {
		ctx.status = 409;

		ctx.body = { validationError: valid.error.message };

		return;
	}

	await next();
};

const requestOtpValidation = async (ctx, next) => {
	try {
		assertSuperAdminOtpRateLimit(ctx.ip || ctx.request.ip, "request");
	} catch (error) {
		rejectOtpRateLimit(ctx, error);
		return;
	}

	const valid = validate(schemas.requestOtp, ctx.request.body);

	if (valid.error) {
		ctx.status = 409;
		ctx.body = { validationError: valid.error.message };
		return;
	}

	await next();
};

const verifyOtpValidation = async (ctx, next) => {
	try {
		assertSuperAdminOtpRateLimit(ctx.ip || ctx.request.ip, "verify");
	} catch (error) {
		rejectOtpRateLimit(ctx, error);
		return;
	}

	const valid = validate(schemas.verifyOtp, ctx.request.body);

	if (valid.error) {
		ctx.status = 409;
		ctx.body = { validationError: valid.error.message };
		return;
	}

	await next();
};

module.exports = {
	getValidation,
	showValidation,
	createValidation,
	updateValidation,
	destroyValidation,
	authValidation,
	requestOtpValidation,
	verifyOtpValidation,
};
