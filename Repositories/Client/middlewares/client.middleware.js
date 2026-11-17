const { string, validate, boolean, number, stringEnum, email } = require("../../../Core/JoiUtils");
const configuration = require("../../../Core/config");
const { TOKEN_TYPES, BLOCKED_PRIVILEGE_TYPES, isBlogOnlySuperAdmin } = require("../../../Core/jwt-claims");

const isClientCaller = (user) => {
	if (!user || typeof user !== "object") return false;
	if (BLOCKED_PRIVILEGE_TYPES.has(user.typ)) return false;
	if (
		user.typ === TOKEN_TYPES.session ||
		user.typ === TOKEN_TYPES.superAdmin ||
		user.typ === TOKEN_TYPES.staff ||
		user.typ === TOKEN_TYPES.lawyer ||
		user.typ === TOKEN_TYPES.duration
	) {
		return false;
	}
	const callerEmail = typeof user.email === "string" ? user.email.trim() : "";
	if (!callerEmail) return false;
	return user.typ === TOKEN_TYPES.client || (!user.typ && Number.isFinite(user.exp));
};

const verifyClientValidation = async (ctx, next) => {
	const query = ctx.request?.query || ctx.query || {};
	const emailParam = typeof query.email === "string" ? query.email.trim() : "";
	const phoneParam = typeof query.phone === "string" ? query.phone.trim() : "";

	if (
		(query.email !== undefined && typeof query.email !== "string") ||
		(query.phone !== undefined && typeof query.phone !== "string") ||
		(!emailParam && !phoneParam)
	) {
		ctx.status = 400;
		ctx.body = {
			error: "CLIENT_IDENTIFIER_REQUIRED",
			code: "CLIENT_IDENTIFIER_REQUIRED",
			validationError: "email or phone is required",
		};
		return;
	}

	await next();
};

const normalizedEmail = (value) => (typeof value === "string" ? value.trim().toLowerCase() : "");

const normalizedPhone = (value) => (typeof value === "string" ? value.trim() : "");

const sessionEmails = (user) => [user?.email, user?.staffEmail].map(normalizedEmail).filter(Boolean);

const sessionPhones = (user) => [user?.phone, user?.staffPhone].map(normalizedPhone).filter(Boolean);

/**
 * Staff and full super-admins may look up any client.
 * A client token may look up only the email or phone carried on that token.
 */
const canLookupClient = (user, email, phone) => {
	if (!user || typeof user !== "object") return false;
	if (isBlogOnlySuperAdmin(user)) return false;

	if (user.typ === TOKEN_TYPES.superAdmin || user.typ === TOKEN_TYPES.staff) return true;

	if (!isClientCaller(user)) return false;

	const emails = sessionEmails(user);
	const phones = sessionPhones(user);

	if (email && !emails.includes(normalizedEmail(email))) return false;
	if (phone && !phones.includes(normalizedPhone(phone))) return false;

	return Boolean(email || phone);
};

const authorizeClientLookup = async (ctx, next) => {
	const query = ctx.request?.query || ctx.query || {};
	const email = normalizedEmail(query.email);
	const phone = normalizedPhone(query.phone);
	const user = ctx.state?.user;

	if (!canLookupClient(user, email, phone)) {
		ctx.status = 403;
		ctx.body = {
			error: "CLIENT_LOOKUP_FORBIDDEN",
			code: "CLIENT_LOOKUP_FORBIDDEN",
		};
		return;
	}

	// Client lookups use the identifier from the verified token, not a caller-supplied variant.
	if (isClientCaller(user)) {
		const query = ctx.request?.query || ctx.query;
		if (query && email) {
			const exactEmail = [user.email, user.staffEmail].find((value) => normalizedEmail(value) === email);
			if (exactEmail) query.email = exactEmail.trim();
		}
		if (query && phone) {
			const exactPhone = [user.phone, user.staffPhone].find((value) => normalizedPhone(value) === phone);
			if (exactPhone) query.phone = exactPhone.trim();
		}
	}

	await next();
};

const schemas = {
	get: {},
	show: {},
	create: {
		name: string().required(),
		countryCode: string().required(),
		phone: string().required(),
		email: email().required(),
		language: stringEnum(["en", "es"]),
		company: string().required(),
		faceBase64: string().required(),
		masterPassword: string().required(),
	},
	update: {
		faceBase64: string().required(),
		masterPassword: string().required(),
		name: string(),
		email: email(),
		countryCode: string(),
		phone: string(),
		company: string(),
	},
	destroy: {},
	auth: {
		email: email(),
		countryCode: string(),
		phone: string(),
		faceBase64: string().required(),
		masterPassword: string().required(),
		identificationMethod: string().required(),
	},
	updatePassword: {
		newPassword: string().required().min(8),
		confirmPassword: string().required(),
		faceBase64: string().required(),
		masterPassword: string().required(),
	},
};

const getValidation = async (ctx, next) => {
	const apiKey = ctx.headers["x-api-key"];

	if (!apiKey || apiKey !== configuration.SUPERADMIN_JWT_SECRET) {
		ctx.status = 403;

		ctx.body = { validationError: "ApiKey not valid" };

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
	const apiKey = ctx.headers["x-api-key"];

	const valid = validate(schemas.show, ctx.request.body);

	if (valid.error) {
		ctx.status = 409;

		ctx.body = { validationError: valid.error.message };

		return;
	}

	await next();
};

const createValidation = async (ctx, next) => {
	const valid = validate(schemas.create, ctx.request.body);

	if (valid.error) {
		ctx.status = 409;

		ctx.body = { validationError: valid.error.message };

		return;
	}

	await next();
};

const destroyValidation = async (ctx, next) => {
	if (!isClientCaller(ctx.state?.user)) {
		ctx.status = 403;
		ctx.body = { error: "CLIENT_AUTH_REQUIRED", code: "CLIENT_AUTH_REQUIRED" };
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
	if (!isClientCaller(ctx.state?.user)) {
		ctx.status = 403;
		ctx.body = { error: "CLIENT_AUTH_REQUIRED", code: "CLIENT_AUTH_REQUIRED" };
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
	const valid = validate(schemas.auth, ctx.request.body);

	if (valid.error) {
		ctx.status = 409;

		ctx.body = { validationError: valid.error.message };

		return;
	}

	await next();
};

const updatePasswordValidation = async (ctx, next) => {
	if (!isClientCaller(ctx.state?.user)) {
		ctx.status = 403;
		ctx.body = { error: "CLIENT_AUTH_REQUIRED", code: "CLIENT_AUTH_REQUIRED" };
		return;
	}

	const valid = validate(schemas.updatePassword, ctx.request.body);

	if (valid.error) {
		ctx.status = 409;

		ctx.body = { validationError: valid.error.message };

		return;
	}

	// Additional validation: check if passwords match
	const { newPassword, confirmPassword } = ctx.request.body;
	if (newPassword !== confirmPassword) {
		ctx.status = 409;

		ctx.body = {
			message: "passwords_do_not_match",
			code: "Conflict",
		};

		return;
	}

	await next();
};

module.exports = {
	verifyClientValidation,
	authorizeClientLookup,
	canLookupClient,
	isClientCaller,
	getValidation,
	showValidation,
	createValidation,
	updateValidation,
	destroyValidation,
	authValidation,
	updatePasswordValidation,
};
