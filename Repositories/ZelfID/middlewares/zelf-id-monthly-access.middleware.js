const Joi = require("joi");
const { normalizeZelfName } = require("../../Tags/modules/zelf-name.util");

const querySchema = Joi.object({
    tagName: Joi.string().trim().min(1).required(),
    domain: Joi.string().trim().min(1).default("zelf"),
}).unknown(true);

const confirmSchema = Joi.object({
    token: Joi.string().trim().min(1).required(),
    method: Joi.string().trim().valid("zns", "card").default("zns"),
}).unknown(true);

const fail = (ctx, status, message, code) => {
    ctx.status = status;
    ctx.body = { message, code };
};

/**
 * Session JWT identity must be the Zelf ID in the query. The 10-minute face window is not required:
 * the extension reads the month before the camera starts.
 */
const requireOwner = (ctx, tagName, domain) => {
    const authUser = ctx.state.user;
    if (!authUser?.tagName) {
        fail(ctx, 401, "Authenticated Zelf identity is required", "ERR_ZELF_IDENTITY_REQUIRED");
        return null;
    }

    const target = normalizeZelfName(tagName, domain || authUser.domain || "zelf");
    const owner = normalizeZelfName(authUser.tagName, authUser.domain || target.domain || "zelf");
    if (!target.zelfName || !owner.zelfName || owner.zelfName !== target.zelfName) {
        fail(ctx, 403, "Session is not the owner of this Zelf ID", "ERR_SESSION_OWNER_MISMATCH");
        return null;
    }

    ctx.state.monthlyAccessName = target;
    return target;
};

const statusValidation = async (ctx, next) => {
    const valid = querySchema.validate(ctx.request.query || {}, { abortEarly: false, convert: true });
    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }
    if (!requireOwner(ctx, valid.value.tagName, valid.value.domain)) return;
    ctx.state.monthlyAccessQuery = valid.value;
    await next();
};

const quoteValidation = statusValidation;

const confirmValidation = async (ctx, next) => {
    const valid = confirmSchema.validate(ctx.request.body || {}, { abortEarly: false, convert: true });
    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }
    if (!ctx.state.user?.tagName) {
        fail(ctx, 401, "Authenticated Zelf identity is required", "ERR_ZELF_IDENTITY_REQUIRED");
        return;
    }
    ctx.state.monthlyAccessConfirm = valid.value;
    await next();
};

module.exports = {
    confirmValidation,
    quoteValidation,
    statusValidation,
};
