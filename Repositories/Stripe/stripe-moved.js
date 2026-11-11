const STRIPE_MOVED_TO_V4 = "STRIPE_MOVED_TO_V4";

/**
 * v3 no longer serves Stripe. Clients that still call these endpoints get 410
 * instead of 404 so they can switch to v4.
 * @param {import("koa").Context} ctx
 */
const respondStripeMoved = (ctx) => {
	ctx.status = 410;
	ctx.body = {
		code: STRIPE_MOVED_TO_V4,
		error: STRIPE_MOVED_TO_V4,
		message: "Stripe is now only supported in v4",
	};
};

module.exports = {
	STRIPE_MOVED_TO_V4,
	respondStripeMoved,
};
