const { string, validate } = require("../../../Core/JoiUtils");
const { errorHandler } = require("../../../Core/http-handler");
const Joi = require("joi");
const ZaiIdentity = require("../modules/zai-identity.module");
const ZaiChat = require("../modules/zai-chat.module");

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

const chatSchema = Joi.object({
    conversationId: Joi.string().max(64),
    message: Joi.string().trim().min(1).max(4000).required(),
    history: Joi.array()
        .max(40)
        .items(Joi.object({ role: Joi.string().valid("user", "assistant").required(), content: Joi.string().allow("").max(4000).required() }).unknown(false))
        .default([]),
    locale: Joi.string().max(10).default("en"),
}).unknown(true); // tagName/domain/zelfName etc. are tolerated but stripped below: identity only comes from the token

/** POST /api/zai/chat: 503 when no model is configured, then Joi body validation. Run after zaiTokenValidation. */
const chatValidation = async (ctx, next) => {
    if (!ZaiChat.isEnabled()) return _reject(ctx, ZaiIdentity.zaiError(503, "ZAI_DISABLED"));

    const { error, value } = chatSchema.validate(ctx.request.body || {}, { abortEarly: false });

    if (error) {
        ctx.status = 400;
        ctx.body = { code: "ZAI_BAD_REQUEST", message: error.message };
        return;
    }

    ctx.request.body = { message: value.message, history: value.history, locale: value.locale, conversationId: value.conversationId };

    await next();
};

module.exports = {
    identityTokenValidation,
    zaiTokenValidation,
    chatValidation,
};
