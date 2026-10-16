const Module = require("../modules/zai-identity.module");
const { errorHandler } = require("../../../Core/http-handler");

/**
 * Exchange an identity token (from decrypt) for a short-lived zAI token
 * @param {Object} ctx - Koa context
 */
const createSession = async (ctx) => {
    try {
        const data = await Module.exchangeForZaiToken(ctx.request.body.identityToken);

        ctx.body = { data };
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;

        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

/**
 * Lock / logout: revoke the identity token and every zAI token derived from it
 * @param {Object} ctx - Koa context
 */
const revokeIdentity = async (ctx) => {
    try {
        const data = await Module.revokeIdentityToken(ctx.request.body.identityToken);

        ctx.body = { data };
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;

        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

/**
 * Current zAI identity (zAI token only)
 * @param {Object} ctx - Koa context
 */
const getMe = async (ctx) => {
    try {
        const data = Module.getZaiIdentity(ctx.state.zai);

        ctx.body = { data };
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;

        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

module.exports = {
    createSession,
    revokeIdentity,
    getMe,
};
