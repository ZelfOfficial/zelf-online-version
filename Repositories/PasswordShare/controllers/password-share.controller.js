const { errorHandler } = require("../../../Core/http-handler");
const Module = require("../modules/password-share.module");

/**
 * Respond with the contract body directly (no `{ data }` wrapper).
 * Pass no Koa ctx into the error handler: its request dump includes the body,
 * and these bodies contain ciphertext.
 */
const send = (fn) => async (ctx) => {
	try {
		ctx.body = await fn(ctx);
	} catch (error) {
		const handled = errorHandler(error);
		ctx.status = handled.status;
		ctx.body = {
			code: handled.code,
			message: handled.message,
		};
		if (error && error.retryAfterSeconds) {
			ctx.set("Retry-After", String(error.retryAfterSeconds));
		}
	}
};

const create = send((ctx) => Module.createShare(ctx.request.body, ctx.state.user));

const list = send((ctx) => Module.listShares(ctx.state.user));

const metadata = send((ctx) => Module.getMetadata(ctx.params.id));

const reveal = send((ctx) => Module.revealShare(ctx.params.id));

const revoke = send((ctx) => Module.revokeShare(ctx.params.id, ctx.state.user));

module.exports = {
	create,
	list,
	metadata,
	reveal,
	revoke,
};
