const { string, validate, boolean, stringEnum, object, array, stringOrNumber } = require("../../../Core/JoiUtils");
const { errorHandler } = require("../../../Core/http-handler");
const PlanLimits = require("../modules/zelf-key-plan-limits.module");
const ZelfKeyZotpModule = require("../modules/zelf-key-zotp.module");
const { ZOTP_ALGORITHMS } = ZelfKeyZotpModule;

/**
 * ZelfKey Middleware - Business logic validation for password manager operations
 * @author Miguel Trevino <miguel@zelf.world>
 */

const SUPPORTED_CATEGORIES = ["password", "notes", "credit_card", "contact", "zotp"];

/** Key protection modes exposed as `publicData.protection`. */
const CARD_HOLDER_NAME_PATTERN = /^(?=.*\p{L})[\p{L}\p{M}\u200C\u200D '\u2019.\u00B7\u30FB-]+$/u;

const PROTECTION_MODES = ["face", "face_password"];
const PROTECTION_FACE = "face";
const PROTECTION_FACE_PASSWORD = "face_password";

/** Maximum credentials per bulk password import request. */
const BULK_PASSWORDS_MAX = 100;

const protectionField = stringEnum(PROTECTION_MODES).optional();

const respondMissingMasterPassword = (ctx) => {
	ctx.status = 400;
	ctx.body = { message: "ERR_MISSING_PASSWORD", code: "ERR_MISSING_PASSWORD" };
};

const ensureStoreMasterPasswordForProtection = (body) => {
	const protection = body?.protection === PROTECTION_FACE_PASSWORD ? PROTECTION_FACE_PASSWORD : PROTECTION_FACE;

	if (protection !== PROTECTION_FACE_PASSWORD) {
		return true;
	}

	const masterPassword = typeof body?.masterPassword === "string" ? body.masterPassword.trim() : "";

	return masterPassword.length > 0;
};

/**
 * Whitespace-only is an empty key password. Passwords that contain any
 * non-whitespace character are left unchanged, including surrounding spaces.
 */
const blankKeyPasswordToEmpty = (value) => {
	if (typeof value !== "string") return value;
	return value.trim() === "" ? "" : value;
};

const optionalKeyPassword = () => string().optional().allow("").custom((value) => blankKeyPasswordToEmpty(value));

const requestProtection = (body) => body?.publicData?.protection ?? body?.protection;

const ensureRetrieveKeyPasswordForProtection = (body) => {
	if (requestProtection(body) !== PROTECTION_FACE_PASSWORD) {
		return true;
	}

	const raw = body?.masterPassword ?? body?.password;
	const keyPassword = typeof raw === "string" ? raw.trim() : "";

	return keyPassword.length > 0;
};

const applyRetrieveKeyPasswordNormalization = (body, validated) => {
	if (!body || !validated) return;

	if (typeof body.password === "string") {
		body.password = validated.password;
	}

	if (typeof body.masterPassword === "string") {
		body.masterPassword = validated.masterPassword;
	}
};

const passwordCredentialSchema = {
	alias: string().optional().allow("").max(50),
	website: string().required(),
	username: string().required(),
	password: string().required(),
	folder: string().optional().allow(""),
	insideFolder: boolean().optional().allow(false),
	notes: string().optional().allow(""),
	protection: protectionField,
	id: string().optional().allow(""),
	cid: string().optional().allow(""),
	recordId: string().optional().allow(""),
};

const schemas = {
	password: {
		// Nombre opcional para reconocer la credencial en el listado (#507).
		alias: string().optional().allow("").max(50),
		website: string().required(),
		username: string().required(),
		password: string().required(),
		folder: string().optional().allow(""),
		insideFolder: boolean().optional().allow(false),
		notes: string().optional().allow(""),
		faceBase64: string().required(),
		masterPassword: string().optional().allow(""),
		protection: protectionField,
		id: string().optional().allow(""),
		cid: string().optional().allow(""),
		recordId: string().optional().allow(""),
	},
	bulkPasswords: {
		faceBase64: string().required(),
		masterPassword: string().optional().allow(""),
		removePGP: boolean().optional(),
		protection: protectionField,
		// Rows are validated one by one in the module, so a bad row comes back in
		// `failed[]` with its index instead of rejecting the whole batch with 409.
		passwords: array().items(object().unknown(true)).min(1).max(BULK_PASSWORDS_MAX).required(),
	},
	zotp: {
		username: string().required(),
		setupKey: string().required(),
		issuer: string().required(),
		algorithm: string().optional(),
		digits: stringOrNumber().optional(),
		period: stringOrNumber().optional(),
		folder: string().optional().allow(""),
		insideFolder: boolean().optional().allow(false),
		faceBase64: string().required(),
		masterPassword: string().optional().allow(""),
		protection: protectionField,
		id: string().optional().allow(""),
		cid: string().optional().allow(""),
		recordId: string().optional().allow(""),
	},
	notes: {
		title: string().min(1).max(100).required(),
		keyValuePairs: object().required(),
		faceBase64: string().required(),
		folder: string().optional().allow(""),
		insideFolder: boolean().optional().allow(false),
		masterPassword: string().optional().allow(""),
		protection: protectionField,
	},
	creditCard: {
		alias: string().optional().allow("").max(50),
		// Same rule as the iOS/Android apps (CardHolderName, #574): letters of any script with
		// their combining marks (and ZWNJ/ZWJ), spaces, and ' ’ - . · ・ — at least one letter.
		cardName: string().trim().pattern(CARD_HOLDER_NAME_PATTERN).required(),
		cardNumber: string().required(),
		expiryMonth: stringEnum(["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"]).required(),
		expiryYear: string().length(4).required(),
		cvv: string().required(),
		bankName: string().required(),
		faceBase64: string().required(),
		folder: string().optional().allow(""),
		insideFolder: boolean().optional().allow(false),
		masterPassword: string().optional().allow(""),
		protection: protectionField,
	},
	changeMasterPassword: {
		faceBase64: string().required(),
		oldMasterPassword: string().required(),
		newMasterPassword: string().required(),
		password: string().optional().allow(""),
		removePGP: boolean().optional(),
	},
	retrieve: {
		zelfProof: string().required(),
		faceBase64: string().required(),
		password: optionalKeyPassword(),
		masterPassword: optionalKeyPassword(),
		// Required for password/notes/cards transport encryption (enforced in the module once the
		// stored type is known); zOTP metadata is returned as-is, so Android/iOS don't send it
		clientPublicKey: string().optional().allow(""),
		type: string().optional().allow(""),
		v: string().optional().allow(""),
		removePGP: boolean().optional(),
		publicData: object().optional(),
		protection: protectionField,
	},
	preview: {
		zelfProof: string().required(),
		faceBase64: string().required(),
	},
	list: {
		category: stringEnum(SUPPORTED_CATEGORIES).required(),
		tagName: string().optional(),
	},
	proof: {
		id: string().required(),
	},
	listAll: {
		tagName: string().optional(),
	},
	listDashboard: {
		identifier: string().required().pattern(/^.+\..+$/),
		category: stringEnum(SUPPORTED_CATEGORIES).optional(),
	},
	listAllDashboard: {
		identifier: string().required().pattern(/^.+\..+$/),
	},
	domainList: {
		domain: string().optional().allow(""),
		page: string().optional().pattern(/^\d+$/),
		pageSize: string().optional().pattern(/^\d+$/),
		type: stringEnum(SUPPORTED_CATEGORIES).optional(),
		owner: string().optional().allow("").max(200),
		search: string().optional().allow("").max(200),
	},
	purchaseSlot: {
		kind: stringEnum(["password", "zotp", "2fa"]).required(),
		idempotencyKey: string().min(8).max(128).pattern(/^[A-Za-z0-9._:-]+$/).required(),
		faceBase64: string().required(),
		password: string().optional().allow(""),
		masterPassword: string().optional().allow(""),
	},
	delete: {
		id: string().required(),
		faceBase64: string().required(),
		password: string().optional().allow(""),
		masterPassword: string().optional().allow(""),
	},
};

/**
 * Store password validation middleware
 */
const storePasswordValidation = async (ctx, next) => {
	const valid = validate(schemas.password, ctx.request.body);

	if (valid.error) {
		ctx.status = 409;
		ctx.body = { validationError: valid.error.message };
		return;
	}

	if (!ensureStoreMasterPasswordForProtection(ctx.request.body)) {
		respondMissingMasterPassword(ctx);
		return;
	}

	await next();
};

/**
 * Bulk store passwords validation middleware
 */
const storePasswordsBulkValidation = async (ctx, next) => {
	const valid = validate(schemas.bulkPasswords, ctx.request.body);

	if (valid.error) {
		ctx.status = 409;
		ctx.body = { validationError: valid.error.message };
		return;
	}

	if (!ensureStoreMasterPasswordForProtection(ctx.request.body)) {
		respondMissingMasterPassword(ctx);
		return;
	}

	await next();
};

/**
 * Store ZOTP validation middleware
 */
const storeZOTPValidation = async (ctx, next) => {
	const valid = validate(schemas.zotp, ctx.request.body);

	if (valid.error) {
		ctx.status = 409;
		ctx.body = { validationError: valid.error.message };
		return;
	}

	const setupKeyResult = ZelfKeyZotpModule.normalizeSetupKey(ctx.request.body.setupKey);
	if (!setupKeyResult.normalized) {
		ctx.status = 409;
		ctx.body = {
			code: setupKeyResult.code,
			validationError: setupKeyResult.message,
		};
		return;
	}

	const totpParams = ZelfKeyZotpModule.resolveZotpTotpParams(ctx.request.body);
	if (totpParams.error) {
		ctx.status = 409;
		ctx.body = {
			code: totpParams.error.code,
			validationError: totpParams.error.message,
		};
		return;
	}

	ctx.request.body.setupKey = setupKeyResult.normalized;
	ctx.request.body.algorithm = totpParams.algorithm;
	ctx.request.body.digits = totpParams.digits;
	ctx.request.body.period = totpParams.period;

	if (!ensureStoreMasterPasswordForProtection(ctx.request.body)) {
		respondMissingMasterPassword(ctx);
		return;
	}

	await next();
};

/**
 * Store notes validation middleware
 */
const storeNotesValidation = async (ctx, next) => {
	const valid = validate(schemas.notes, ctx.request.body);

	if (valid.error) {
		ctx.status = 409;
		ctx.body = { validationError: valid.error.message };
		return;
	}

	if (!ensureStoreMasterPasswordForProtection(ctx.request.body)) {
		respondMissingMasterPassword(ctx);
		return;
	}

	// Additional business logic: validate key-value pairs
	const { keyValuePairs } = ctx.request.body;
	const pairs = Object.entries(keyValuePairs || {});

	if (pairs.length === 0) {
		ctx.status = 409;
		ctx.body = { validationError: "At least one key-value pair is required" };
		return;
	}

	// Validate maximum number of key-value pairs
	if (pairs.length > 10) {
		ctx.status = 409;
		ctx.body = { validationError: "Maximum 10 key-value pairs allowed" };
		return;
	}

	// Validate each key-value pair
	for (const [key, value] of pairs) {
		if (!key || key.trim().length === 0) {
			ctx.status = 409;
			ctx.body = { validationError: "Key names cannot be empty" };
			return;
		}
		if (key.length > 50) {
			ctx.status = 409;
			ctx.body = { validationError: "Key names cannot exceed 50 characters" };
			return;
		}
		if (typeof value !== "string" || value.length > 1000) {
			ctx.status = 409;
			ctx.body = { validationError: "Values must be strings and cannot exceed 1000 characters" };
			return;
		}
	}

	await next();
};

/**
 * Store credit card validation middleware
 */
const storeCreditCardValidation = async (ctx, next) => {
	const valid = validate(schemas.creditCard, ctx.request.body);

	if (valid.error) {
		ctx.status = 409;
		ctx.body = { validationError: valid.error.message };
		return;
	}

	if (!ensureStoreMasterPasswordForProtection(ctx.request.body)) {
		respondMissingMasterPassword(ctx);
		return;
	}

	// Additional business logic: validate credit card number format
	const { expiryMonth, expiryYear } = ctx.request.body;

	// Validate expiry date
	const currentYear = new Date().getFullYear();
	const currentMonth = new Date().getMonth() + 1;

	if (parseInt(expiryYear) < currentYear || (parseInt(expiryYear) === currentYear && parseInt(expiryMonth) < currentMonth)) {
		ctx.status = 409;
		ctx.body = { validationError: "Credit card has expired" };
		return;
	}

	await next();
};

/**
 * Retrieve data validation middleware
 */
const retrieveValidation = async (ctx, next) => {
	const valid = validate(schemas.retrieve, ctx.request.body);

	if (valid.error) {
		ctx.status = 409;
		ctx.body = { validationError: valid.error.message };
		return;
	}

	applyRetrieveKeyPasswordNormalization(ctx.request.body, valid.value);

	if (!ensureRetrieveKeyPasswordForProtection(ctx.request.body)) {
		respondMissingMasterPassword(ctx);
		return;
	}

	await next();
};

const proofValidation = async (ctx, next) => {
	const valid = validate(schemas.proof, ctx.request.query);

	if (valid.error) {
		ctx.status = 409;
		ctx.body = { validationError: valid.error.message };
		return;
	}

	await next();
};

const listValidation = async (ctx, next) => {
	const valid = validate(schemas.list, ctx.request.query);

	if (valid.error) {
		ctx.status = 409;
		ctx.body = { validationError: valid.error.message };
		return;
	}

	await next();
};

const listAllValidation = async (ctx, next) => {
	const valid = validate(schemas.listAll, ctx.request.query);

	if (valid.error) {
		ctx.status = 409;
		ctx.body = { validationError: valid.error.message };
		return;
	}

	await next();
};

/**
 * Dashboard list validation - requires identifier (user.domain format)
 */
const listDashboardValidation = async (ctx, next) => {
	const valid = validate(schemas.listDashboard, ctx.request.query);

	if (valid.error) {
		ctx.status = 409;
		ctx.body = { validationError: valid.error.message };
		return;
	}

	await next();
};

/**
 * Dashboard list-all validation - requires identifier (user.domain format)
 */
const listAllDashboardValidation = async (ctx, next) => {
	const valid = validate(schemas.listAllDashboard, ctx.request.query);

	if (valid.error) {
		ctx.status = 409;
		ctx.body = { validationError: valid.error.message };
		return;
	}

	await next();
};

/**
 * Preview data validation middleware
 */
const domainListValidation = async (ctx, next) => {
	const valid = validate(schemas.domainList, ctx.request.query);

	if (valid.error) {
		ctx.status = 409;
		ctx.body = { validationError: valid.error.message };
		return;
	}

	await next();
};

const previewValidation = async (ctx, next) => {
	const valid = validate(schemas.preview, ctx.request.body);

	if (valid.error) {
		ctx.status = 409;
		ctx.body = { validationError: valid.error.message };
		return;
	}

	await next();
};

const summaryValidation = async (_ctx, next) => {
	await next();
};

const changeMasterPasswordValidation = async (ctx, next) => {
	const valid = validate(schemas.changeMasterPassword, ctx.request.body);

	if (valid.error) {
		ctx.status = 409;
		ctx.body = { validationError: valid.error.message };
		return;
	}

	await next();
};

const requireZelfIdentity = (ctx) => {
	const tagName = typeof ctx.state.user?.tagName === "string" ? ctx.state.user.tagName.trim() : "";
	if (tagName) return true;

	ctx.status = 401;
	ctx.body = {
		message: "Authenticated Zelf identity is required",
		code: "ERR_ZELF_IDENTITY_REQUIRED",
	};
	return false;
};

const limitsValidation = async (ctx, next) => {
	if (!requireZelfIdentity(ctx)) return;
	await next();
};

const sendPlanLimitError = (ctx, error) => {
	const handled = errorHandler(error);
	ctx.status = handled.status;
	ctx.body = {
		message: handled.message,
		code: handled.code,
		...(error?.details && typeof error.details === "object" ? error.details : {}),
	};
};

const purchaseSlotValidation = async (ctx, next) => {
	if (!requireZelfIdentity(ctx)) return;

	const body = ctx.request.body || {};

	try {
		PlanLimits.normalizeKind(body.kind);
		PlanLimits.assertIdempotencyKey(body.idempotencyKey);
	} catch (error) {
		sendPlanLimitError(ctx, error);
		return;
	}

	const valid = validate(schemas.purchaseSlot, body);

	if (valid.error) {
		ctx.status = 409;
		ctx.body = { validationError: valid.error.message };
		return;
	}

	await next();
};

const deleteZelfKeyValidation = async (ctx, next) => {
	const valid = validate(schemas.delete, {
		id: ctx.request.params.id,
		faceBase64: ctx.request.body.faceBase64 || "",
		password: ctx.request.body.password || "",
		masterPassword: ctx.request.body.masterPassword || "",
	});

	if (valid.error) {
		ctx.status = 409;
		ctx.body = { validationError: valid.error.message };
		return;
	}

	await next();
};

module.exports = {
	ZOTP_ALGORITHMS,
	SUPPORTED_CATEGORIES,
	PROTECTION_MODES,
	PROTECTION_FACE,
	PROTECTION_FACE_PASSWORD,
	BULK_PASSWORDS_MAX,
	ensureStoreMasterPasswordForProtection,
	ensureRetrieveKeyPasswordForProtection,
	blankKeyPasswordToEmpty,
	respondMissingMasterPassword,
	passwordCredentialSchema,
	storePasswordValidation,
	storePasswordsBulkValidation,
	storeZOTPValidation,
	storeNotesValidation,
	storeCreditCardValidation,
	CARD_HOLDER_NAME_PATTERN,
	retrieveValidation,
	previewValidation,
	proofValidation,
	listValidation,
	listAllValidation,
	listDashboardValidation,
	listAllDashboardValidation,
	domainListValidation,
	summaryValidation,
	changeMasterPasswordValidation,
	limitsValidation,
	purchaseSlotValidation,
	deleteZelfKeyValidation,
};
