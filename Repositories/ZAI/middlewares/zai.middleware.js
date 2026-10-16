const { string, validate } = require("../../../Core/JoiUtils");
const { errorHandler } = require("../../../Core/http-handler");
const ZaiIdentity = require("../modules/zai-identity.module");

const schemas = {
    identityToken: {
        identityToken: string().required(),
    },
};

const _bearer = (ctx) => {
    const header = ctx.headers?.authorization || "";
    const match = header.match(/^(?:Bearer|JWT)\s+(.+)$/i);
    return match ? match[1].trim() : null;
};

const _reject = (ctx, error) => {
    const _exception = errorHandler(error, ctx);
    ctx.status = _exception.status;
    ctx.body = { message: _exception.message, code: _exception.code };
};

/**
 * POST /api/zai/session and /api/zai/revoke: identity token from body.identityToken or the Bearer header.
 * Normalised into ctx.request.body.identityToken.
 */
const identityTokenValidation = async (ctx, next) => {
    const identityToken = ctx.request.body?.identityToken || _bearer(ctx);

    if (!identityToken) return _reject(ctx, ZaiIdentity.zaiError(401, "ZAI_TOKEN_MISSING"));

    const valid = validate(schemas.identityToken, { identityToken });

    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    ctx.request.body = { ...(ctx.request.body || {}), identityToken };

    await next();
};

/** Guard for /api/zai/*: only zAI tokens (typ=zai, scope zai:chat). Session JWTs and identity tokens get 403. */
const zaiTokenValidation = async (ctx, next) => {
    try {
        const claims = await ZaiIdentity.verifyZaiToken(_bearer(ctx));
        ctx.state.zai = ZaiIdentity.toZaiState(claims);
    } catch (error) {
        return _reject(ctx, error);
    }

    await next();
};

module.exports = {
    identityTokenValidation,
    zaiTokenValidation,
};
