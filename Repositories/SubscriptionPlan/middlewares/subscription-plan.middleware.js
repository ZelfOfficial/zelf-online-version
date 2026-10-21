const { string, validate } = require("../../../Core/JoiUtils");
const { checkoutSessionIdJoi } = require("../../Stripe/modules/stripe-checkout-session.module");

const schemas = {
	getById: {
		productId: string().required(),
	},
	subscribe: {
		productId: string().required(),
		priceId: string().required(),
	},
	verifySession: {
		sessionId: checkoutSessionIdJoi(),
	},
};

const getByIdValidation = async (ctx, next) => {
	const { productId } = ctx.params;

	const valid = validate(schemas.getById, { productId });

	if (valid.error) {
		ctx.status = 409;
		ctx.body = { validationError: valid.error.message };
		return;
	}

	await next();
};

const subscribeValidation = async (ctx, next) => {
	const { productId, priceId } = ctx.request.body;

	const valid = validate(schemas.subscribe, { productId, priceId });

	if (valid.error) {
		ctx.status = 409;
		ctx.body = { validationError: valid.error.message };
		return;
	}

	await next();
};

const mySubscriptionValidation = async (ctx, next) => {
	await next();
};

const createPortalSessionValidation = async (ctx, next) => {
	// No specific validation needed for portal session creation
	// The user authentication is handled by the auth middleware
	await next();
};

const verifySessionValidation = async (ctx, next) => {
	const raw = ctx.request.body?.sessionId;
	const trimmed = typeof raw === "string" ? raw.trim() : raw;

	if (raw === undefined || raw === null || trimmed === "") {
		ctx.status = 409;
		ctx.body = { validationError: "missing sessionId\n" };
		return;
	}

	const valid = validate(schemas.verifySession, { sessionId: trimmed });

	if (valid.error) {
		ctx.status = 400;
		ctx.body = { message: "Checkout session id format is invalid", code: "invalid_session_id" };
		return;
	}

	ctx.request.body = { ...ctx.request.body, sessionId: trimmed };
	await next();
};

module.exports = {
	getByIdValidation,
	subscribeValidation,
	mySubscriptionValidation,
	createPortalSessionValidation,
	verifySessionValidation,
};
