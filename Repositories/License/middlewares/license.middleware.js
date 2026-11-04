const { string, validate, stringEnum, object, array, number, boolean } = require("../../../Core/JoiUtils");
const config = require("../../../Core/config");

const schemas = {
	search: {
		domain: string().pattern(/^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$/),
		withJSON: boolean().default(true),
		includeThemeSettings: stringEnum(["1", "0", "true", "false"]).optional(),
	},
	getMyLicense: {
		withJSON: boolean().default(true),
	},
	create: {
		domain: string()
			.pattern(/^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$/)
			.required(),
		faceBase64: string().base64().required(),
		masterPassword: string().optional().allow(""),
		logoBase64: string().optional().allow(""), // Data URI or raw base64; validated in module
		os: stringEnum(["DESKTOP", "ANDROID", "IOS"]).optional(),
		domainConfig: object({
			name: string().required(),
			holdSuffix: string().default(".hold"),
			status: stringEnum(["active", "inactive", "suspended"]).default("active"),
			owner: string().optional(),
			description: string().optional(),
			// Note: limits are managed by Stripe subscription, not sent from frontend
			tags: object({
				minLength: number().integer().min(1).required(),
				maxLength: number().integer().min(1).required(),
				allowedChars: object().default({}),
				reserved: array().items(string()).default([]),
				customRules: array().items(string()).default([]),
				payment: object({
					methods: array()
						.items(stringEnum(["crypto", "stripe"]))
						.required(),
					networks: object()
						.pattern(
							string(),
							object({
								enabled: boolean().required(),
								nativeCurrency: object({
									enabled: boolean().required(),
									code: string().required(),
								}).required(),
								altCoins: object({
									enabled: boolean().required(),
									standard: string().allow("", null).optional(),
									showAll: boolean().default(true),
									specificTokens: array().items(string()).default([]),
								}).optional(),
							}),
						)
						.default({}),
					currencies: array()
						.items(stringEnum(["BTC", "ETH", "SOL", "USDC", "USDT", "BDAG", "AVAX", "BNB", "POL", "BASE", "ZNS"]))
						.optional(),
					discounts: object({
						yearly: number().min(0).max(1).default(0.1),
						lifetime: number().min(0).max(1).default(0.2),
					}).default({}),
					rewardPrice: number().min(0).default(10),
					whitelist: object().default({}),
					pricingTable: object()
						.pattern(
							/^(\d+|\d+-\d+)$/, // Pattern for keys like "1", "2", "6-15", etc.
							object({
								1: number().min(0),
								2: number().min(0),
								3: number().min(0),
								4: number().min(0),
								5: number().min(0),
								lifetime: number().min(0),
							}),
						)
						.required(),
					planPricing: object({
						premium: object()
							.pattern(
								/^(\d+|\d+-\d+)$/,
								object({
									1: number().min(0),
									2: number().min(0),
									3: number().min(0),
									4: number().min(0),
									5: number().min(0),
									lifetime: number().min(0),
								}),
							)
							.optional(),
						unlimited: object()
							.pattern(
								/^(\d+|\d+-\d+)$/,
								object({
									1: number().min(0),
									2: number().min(0),
									3: number().min(0),
									4: number().min(0),
									5: number().min(0),
									lifetime: number().min(0),
								}),
							)
							.optional(),
					}).optional(),
				}).required(),
				storage: object({
					keyPrefix: string().required(),
					ipfsEnabled: boolean().default(true),
					arweaveEnabled: boolean().default(false),
					walrusEnabled: boolean().default(false),
					backupEnabled: boolean().default(false),
					// Note: backupEnabled is not allowed in frontend payload
				}).required(),
				wallet: object({
					networks: object()
						.pattern(
							string(),
							object({
								enabled: boolean().required(),
							}),
						)
						.required(),
				}).required(),
			}).required(),
			zelfkeys: object({
				plans: array().items(object()).default([]),
				planLimits: object()
					.pattern(
						string(),
						object({
							passwords: number().integer().min(0).allow(null),
							zotp: number().integer().min(0).allow(null),
						 }),
					)
					.optional(),
				payment: object({
					whitelist: object().default({}),
					pricingTable: object().default({}),
				}).default({}),
				storage: object({
					keyPrefix: string().required(),
					ipfsEnabled: boolean().default(true),
					arweaveEnabled: boolean().default(false),
					walrusEnabled: boolean().default(false),
					backupEnabled: boolean().default(false),
					// Note: backupEnabled is not allowed in frontend payload
				}).required(),
			}).required(),
			metadata: object({
				launchDate: string().isoDate().optional(),
				version: string().optional(),
				documentation: string().uri().optional(),
				community: string().optional(),
				enterprise: string().optional(),
				support: stringEnum(["standard", "premium", "enterprise"]).default("standard"),
				logo: string().uri().optional(),
			}).optional(),
		}).required(),
	},
	delete: {
		faceBase64: string().base64().required(),
		masterPassword: string().optional().allow(""),
	},
};

/**
 * Search License Validation
 * @param {*} ctx
 * @param {*} next
 */
const searchValidation = async (ctx, next) => {
	const payload = Object.assign(ctx.request.query, ctx.request.body);

	const { domain, withJSON, includeThemeSettings } = payload;

	const valid = validate(schemas.search, {
		domain,
		withJSON,
		includeThemeSettings,
	});

	if (valid.error) {
		ctx.status = 409;
		ctx.body = { validationError: valid.error.message };
		return;
	}

	await next();
};

/**
 * Get My License Validation
 * @param {*} ctx
 * @param {*} next
 */
const getMyLicenseValidation = async (ctx, next) => {
	if (!ctx.state.user.email && !ctx.state.user.staffEmail) {
		ctx.status = 409;
		ctx.body = { validationError: "User not authenticated" };
		return;
	}

	const payload = Object.assign(ctx.request.query, ctx.request.body);

	const valid = validate(schemas.getMyLicense, payload);

	if (valid.error) {
		ctx.status = 409;
		ctx.body = { validationError: valid.error.message };
		return;
	}

	await next();
};

/**
 * Create License Validation
 * @param {*} ctx
 * @param {*} next
 */
const createValidation = async (ctx, next) => {
	const payload = Object.assign(ctx.request.query, ctx.request.body);

	const { domain, faceBase64, masterPassword, logoBase64, os, domainConfig } = payload;

	const valid = validate(schemas.create, {
		domain,
		faceBase64,
		masterPassword,
		logoBase64,
		os,
		domainConfig,
	});

	if (valid.error) {
		ctx.status = 409;
		ctx.body = { validationError: valid.error.message };
		return;
	}

	await next();
};

/**
 * Delete License Validation
 * @param {*} ctx
 * @param {*} next
 */
const deleteValidation = async (ctx, next) => {
	const { faceBase64, masterPassword } = ctx.request.body;

	const valid = validate(schemas.delete, {
		faceBase64,
		masterPassword,
	});

	if (valid.error) {
		ctx.status = 409;
		ctx.body = { validationError: valid.error.message };
		return;
	}

	await next();
};

module.exports = {
	searchValidation,
	getMyLicenseValidation,
	createValidation,
	deleteValidation,
};
