const { errorHandler } = require("../../../Core/http-handler");
const { assertPasswordShareRateLimit } = require("../modules/password-share-rate-limit.module");

/**
 * koa-body keeps the raw JSON beside the parsed body. These routes carry
 * ciphertext, so drop that copy before a later logger or error reporter can
 * see it. The parsed fields the handler needs stay in place.
 */
const discardRawBody = async (ctx, next) => {
	const request = ctx.request;
	if (request) {
		request.rawBody = undefined;
		const body = request.body;
		if (body && typeof body === "object") {
			for (const key of Object.getOwnPropertySymbols(body)) {
				delete body[key];
			}
		}
	}

	await next();
};

const rateLimit = (kind) => async (ctx, next) => {
	try {
		const identifier = kind === "create" ? ctx.state?.user?.identifier : undefined;
		assertPasswordShareRateLimit(kind, ctx.ip || ctx.request.ip, identifier);
	} catch (error) {
		const handled = errorHandler(error);
		ctx.status = handled.status;
		ctx.body = { code: handled.code, message: handled.message };
		if (error.retryAfterSeconds) ctx.set("Retry-After", String(error.retryAfterSeconds));
		return;
	}

	await next();
};

module.exports = {
	discardRawBody,
	rateLimit,
};
