const { string, validate, boolean, number, stringEnum } = require("../../../Core/JoiUtils");
const { TOKEN_TYPES } = require("../../../Core/jwt-claims");
const Session = require("../../Session/models/session.model");
const moment = require("moment");
const { validateDomainAndName } = require("../../Tags/middlewares/tags.middleware");

const schemas = {
	transfer: {
		zelfName: string().required(),
		faceBase64: string().required(),
		password: string().required(),
	},
	renew: {
		network: string().required(),
		token: string().required(),
	},
	howToRenew: {
		domain: string().required(),
		tagName: string().required(),
	},
};

const transferValidation = async (ctx, next) => {
	const valid = validate(schemas.transfer, ctx.request.body);

	if (valid.error) {
		ctx.status = 409;

		ctx.body = { validationError: valid.error.message };

		return;
	}

	const { zelfName } = ctx.request.body;

	const failed = validateZelfName(zelfName, ctx);

	if (failed) return;

	await next();
};

/**
 *
 * @param {Object} ctx
 * @param {Object} next
 */
const howToRenewValidation = async (ctx, next) => {
	const valid = validate(schemas.howToRenew, ctx.request.query);

	if (valid.error) {
		ctx.status = 409;
		ctx.body = { validationError: valid.error.message };
		return;
	}

	const { domain, tagName } = ctx.request.query;

	const domainValidation = await validateDomainAndName(domain, tagName);

	if (!domainValidation.valid) {
		ctx.status = 409;
		ctx.body = { validationError: domainValidation.error };
		return;
	}

	await next();
};

const renewValidation = async (ctx, next) => {
	const valid = validate(schemas.renew, ctx.request.body);

	if (valid.error) {
		ctx.status = 409;
		ctx.body = { validationError: valid.error.message };
		return;
	}

	if (ctx.state.user?.typ !== TOKEN_TYPES.quote) {
		ctx.status = 401;
		ctx.body = { validationError: "INVALID_TOKEN_TYPE", code: "INVALID_TOKEN_TYPE" };
		return;
	}

	const { ttl, zelfName, ethPrices, solPrices, paymentAddress } = ctx.state.user;

	if (!ttl || !zelfName || !ethPrices || !solPrices || !paymentAddress) {
		ctx.status = 409;
		ctx.body = { validationError: "Prices expired, generate a new token" };
		return;
	}

	if (moment.unix(ttl).isBefore(moment())) {
		ctx.status = 409;
		ctx.body = { validationError: "Prices expired, generate a new token" };
		return;
	}

	await next();
};

module.exports = {
	transferValidation,
	howToRenewValidation,
	renewValidation,
};
