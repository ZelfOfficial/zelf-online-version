const { string, validate, boolean, number } = require("../../../Core/JoiUtils");

const schemas = {
	createWallet: {
		zelfName: string().required(),
		faceBase64: string().required(),
		password: string(),
		addServerPassword: boolean(),
		wordsCount: number().required(),
	},
	decryptWallet: {
		faceBase64: string().required(),
		identifier: string(),
		password: string(),
		zelfProof: string(),
		addServerPassword: boolean(),
	},
	zkProof: {
		faceBase64: string().required(),
		identifier: string(),
		password: string(),
		zelfProof: string(),
		addServerPassword: boolean(),
		zkProof: string().required(),
	},
	seeWallet: {
		identifier: string(),
		zelfProof: string().required(),
		addServerPassword: boolean(),
	},
	import: {
		zelfName: string().required(),
		faceBase64: string().required(),
		password: string(),
		phrase: string().required(),
	},
	searchOpenWallets: {
		address: string().required(),
	},
	uploadToIPFS: {
		qrCode: string().required(),
	},
};

/**
 * Get Validation
 * @param {*} request
 * @param {*} response
 * @param {*} next
 */
const getValidation = async (ctx, next) => {
	await next();
};

/**
 * Show Validation
 * @param {*} request
 * @param {*} response
 * @param {*} next
 */
const showValidation = async (ctx, next) => {
	await next();
};

/**
 * Create Validation
 * @param {*} request
 * @param {*} response
 * @param {*} next
 */
const createValidation = async (ctx, next) => {
	const valid = validate(schemas.createWallet, ctx.request.body);

	const { clientId } = ctx.state.user;

	if (!clientId) {
		ctx.status = 409;

		ctx.body = { validationError: "Access forbidden. contact us for a valid API Key" };

		return;
	}

	if (valid.error) {
		ctx.status = 409;

		ctx.body = { validationError: valid.error.message };

		return;
	}

	const invalidZelfName = _isZelfNameInvalid(ctx.request.body);

	if (invalidZelfName) {
		ctx.status = invalidZelfName.status;

		ctx.body = invalidZelfName.body;

		return;
	}

	await next();
};

const _isZelfNameInvalid = (body) => {
	if (!body.zelfName) return;

	body.zelfName = body.zelfName.toLowerCase();

	// First, check if the name ends with '.zelf'
	if (!body.zelfName.endsWith(".zelf")) {
		return {
			status: 409,
			body: { validationError: "Zelf name must end with '.zelf'." },
		};
	}

	if (body.zelfName.length > 20) {
		return {
			status: 409,
			body: { validationError: "Zelf name must be 20 characters or fewer." },
		};
	}

	// Extract the part before '.zelf'
	const nameWithoutSuffix = body.zelfName.slice(0, -5); // Remove the last '.zelf'

	const zelfNamePattern = /^[a-z]+[a-z0-9]*(?:[.-][a-z0-9]+)*[a-z0-9]$/;

	if (!zelfNamePattern.test(nameWithoutSuffix)) {
		return {
			status: 409,
			body: { validationError: "Zelf name must include '.zelf', contain only letters, and have no special characters or numbers." },
		};
	}
};

const decryptWalletValidation = async (ctx, next) => {
	const valid = validate(schemas.decryptWallet, ctx.request.body);

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

/**
 * Wallet export accepts an API client or an extension session JWT.
 */
const exportWalletValidation = async (ctx, next) => {
	const valid = validate(schemas.decryptWallet, ctx.request.body);

	if (valid.error) {
		ctx.status = 409;

		ctx.body = { validationError: valid.error.message };

		return;
	}

	const user = ctx.state.user || {};

	if (!user.clientId && !user.session) {
		ctx.status = 409;

		ctx.body = { validationError: "Access forbidden. contact us for a valid API Key" };

		return;
	}

	await next();
};

const zkProofValidation = async (ctx, next) => {
	const valid = validate(schemas.zkProof, ctx.request.body);

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

const seeWalletValidation = async (ctx, next) => {
	const valid = validate(schemas.seeWallet, ctx.request.body);

	if (valid.error) {
		ctx.status = 409;

		ctx.body = { validationError: valid.error.message };

		return;
	}

	// This route is public. Callers have no JWT, so `ctx.state.user` is absent.
	const user = ctx.state.user;
	if (user && !user.clientId) {
		ctx.status = 409;

		ctx.body = { validationError: "Access forbidden. contact us for a valid API Key" };

		return;
	}

	await next();
};

/**
 * Update Validation
 * @param {*} request
 * @param {*} response
 * @param {*} next
 */
const updateValidation = async (ctx, next) => {
	await next();
};

/**
 * Destroy Validation
 * @param {*} request
 * @param {*} response
 * @param {*} next
 */
const importValidation = async (ctx, next) => {
	const valid = validate(schemas.import, ctx.request.body);

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

	const invalidZelfName = _isZelfNameInvalid(ctx.request.body);

	if (invalidZelfName) {
		ctx.status = invalidZelfName.status;

		ctx.body = invalidZelfName.body;

		return;
	}

	await next();
};

const searchOpenWalletsValidation = async (ctx, next) => {
	const valid = validate(schemas.searchOpenWallets, ctx.request.query);

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

const ipfsValidation = async (ctx, next) => {
	const valid = validate(schemas.uploadToIPFS, ctx.request.body);

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

module.exports = {
	getValidation,
	showValidation,
	createValidation,
	decryptWalletValidation,
	exportWalletValidation,
	seeWalletValidation,
	updateValidation,
	importValidation,
	searchOpenWalletsValidation,
	ipfsValidation,
	zkProofValidation,
};
