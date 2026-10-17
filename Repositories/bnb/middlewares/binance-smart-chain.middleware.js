const { string, validate, showRecords } = require("../../../Core/JoiUtils");

const schemas = {
	validateAddress: {
		address: string().required(),
	},
	validateAddressParam: {
		id: string()
			.pattern(/^0x[a-fA-F0-9]{40}$/)
			.required(),
	},
	validateTransactionHashs: {
		transactionHash: string().required(),
	},
	validateAddressTransactions: {
		page: string().required(),
		show: showRecords().required(),
	},
	validateToken: {
		page: string(),
		show: showRecords(),
	},
};

const validateAddress = async (ctx, next) => {
	const valid = validate(schemas.validateAddress, ctx.request.query);

	if (valid.error) {
		ctx.status = 409;

		ctx.body = { validationError: valid.error.message };

		return;
	}

	await next();
};

/** GET /bsc/address/:id — :id must be a 0x EVM address (the balance lookup goes straight to RPC). */
const validateAddressParam = async (ctx, next) => {
	const valid = validate(schemas.validateAddressParam, ctx.request.params);

	if (valid.error) {
		ctx.status = 409;

		ctx.body = { validationError: valid.error.message };

		return;
	}

	await next();
};

const validateTransactionHashs = async (ctx, next) => {
	const valid = validate(schemas.validateTransactionHashs, ctx.request.query);

	if (valid.error) {
		ctx.status = 409;

		ctx.body = { validationError: valid.error.message };

		return;
	}

	await next();
};

const validateToken = async (ctx, next) => {
	const valid = validate(schemas.validateToken, ctx.request.query);

	if (valid.error) {
		ctx.status = 409;

		ctx.body = { validationError: valid.error.message };

		return;
	}

	await next();
};

const validateAddressTransactions = async (ctx, next) => {
	const valid = validate(schemas.validateAddressTransactions, ctx.request.query);

	if (valid.error) {
		ctx.status = 409;

		ctx.body = { validationError: valid.error.message };

		return;
	}

	await next();
};

module.exports = {
	validateAddress,
	validateAddressParam,
	validateTransactionHashs,
	validateAddressTransactions,
	validateToken,
};
