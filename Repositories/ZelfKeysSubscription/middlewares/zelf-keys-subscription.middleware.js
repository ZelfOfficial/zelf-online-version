const configuration = require("../../../Core/config");
const { validate, string } = require("../../../Core/JoiUtils");
const { checkoutSessionIdJoi } = require("../../Stripe/modules/stripe-checkout-session.module");

const availablePlanKeys =
	Array.isArray(configuration.stripe?.plans) || typeof configuration.stripe?.plans === "object" ? Object.keys(configuration.stripe.plans) : [];

const schemas = {
	checkout: {
		planId: string()
			.required()
			.valid(...availablePlanKeys),
	},
	checkSession: {
		sessionId: checkoutSessionIdJoi(),
	},
};

const validateUserIdentifier = async (ctx, next) => {
	const { identifier } = ctx.state.user || {};

	if (!identifier) {
		ctx.status = 400;
		ctx.body = {
			error: "ZelfName identifier is required",
		};

		return;
	}

	await next();
};

const validateCheckoutRequest = async (ctx, next) => {
	try {
		const valid = validate(schemas.checkout, ctx.request.body);

		if (valid.error) {
			ctx.status = 400;
			ctx.body = {
				error: "Validation error",
				message: valid.error.message,
				availablePlans: availablePlanKeys,
			};

			return;
		}

		ctx.state.planDetails = configuration.stripe.plans[ctx.request.body.planId];

		await next();
	} catch (error) {
		console.error("Checkout validation error:", error);

		ctx.status = 500;
		ctx.body = {
			error: "Request validation failed",
			message: error.message,
		};
	}
};

const validateCheckSessionRequest = async (ctx, next) => {
	const raw = ctx.request.body?.sessionId;
	const trimmed = typeof raw === "string" ? raw.trim() : raw;

	if (raw === undefined || raw === null || trimmed === "") {
		ctx.status = 400;
		ctx.body = {
			success: false,
			message: "Checkout session id is required",
			code: "invalid_session_id",
		};
		return;
	}

	const valid = validate(schemas.checkSession, { sessionId: trimmed });

	if (valid.error) {
		ctx.status = 400;
		ctx.body = {
			success: false,
			message: "Checkout session id format is invalid",
			code: "invalid_session_id",
		};
		return;
	}

	ctx.request.body = { ...ctx.request.body, sessionId: trimmed };
	await next();
};

module.exports = {
	validateUserIdentifier,
	validateCheckoutRequest,
	validateCheckSessionRequest,
};
