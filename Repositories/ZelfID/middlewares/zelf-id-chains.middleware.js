const Joi = require("joi");
const Session = require("../../Session/models/session.model");

const { normalizeZelfName } = require("../../Tags/modules/zelf-name.util");
const { requireVerifiedWallet } = require("../../ZelfKeys/middlewares/zelf-key.middleware");

const activateSchema = Joi.object({
    chain: Joi.string().trim().min(1).max(64).required(),
}).unknown(true);

const fail = (ctx, status, message, code) => {
    ctx.status = status;
    ctx.body = { message, code };
};

/**
 * Logged-in owner for POST /chains/activate.
 * The wallet is the server stamp from a matching decrypt, not a name sent at session create.
 * @param {Object} ctx
 * @returns {Promise<boolean>}
 */
const requireSessionOwner = async (ctx) => {
    const authUser = ctx.state.user;
    if (!authUser?.session) {
        fail(ctx, 401, "A session is required", "ERR_SESSION_REQUIRED");
        return false;
    }

    const session = await Session.findById(authUser.session).lean();
    if (!session || session.status !== "active") {
        fail(ctx, 401, "A session is required", "ERR_SESSION_REQUIRED");
        return false;
    }

    const domain = session.domain || authUser.domain || "zelf";
    const verified = normalizeZelfName(session.verifiedTagName, domain);
    const expired = !session.verifiedUntil || new Date(session.verifiedUntil).getTime() <= Date.now();

    if (!verified.zelfName || expired) {
        fail(ctx, 403, "Session is not verified for this wallet", "ERR_SESSION_NOT_VERIFIED");
        return false;
    }

    const tokenWallet = normalizeZelfName(authUser.tagName, authUser.domain || domain);
    if (tokenWallet.zelfName && tokenWallet.zelfName !== verified.zelfName) {
        fail(ctx, 403, "Session is not the owner of this Zelf ID", "ERR_SESSION_OWNER_MISMATCH");
        return false;
    }

    ctx.state.user = {
        ...authUser,
        tagName: verified.tagName,
        domain: verified.domain,
    };
    return true;
};

const statusValidation = async (ctx, next) => {
    if (!(await requireVerifiedWallet(ctx))) return;
    await next();
};

const activateValidation = async (ctx, next) => {
    if (!(await requireSessionOwner(ctx))) return;

    const valid = activateSchema.validate(ctx.request.body || {}, { abortEarly: false, convert: true, stripUnknown: false });
    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    ctx.request.body = { ...ctx.request.body, ...valid.value };
    await next();
};

module.exports = {
    activateValidation,
    statusValidation,
};
