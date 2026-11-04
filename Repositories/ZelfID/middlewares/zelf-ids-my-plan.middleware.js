const Joi = require("joi");
const Session = require("../../Session/models/session.model");
const { normalizeZelfName } = require("../../Tags/modules/zelf-name.util");

const querySchema = Joi.object({
    zelfName: Joi.string().trim().min(1).required(),
}).unknown(true);

const fail = (ctx, status, message, code) => {
    ctx.status = status;
    ctx.body = { message, code };
};

/**
 * Verified owner: session verifiedTagName equals the normalized zelfName and verifiedUntil is still open.
 * Missing session is 401. A session that does not match is 403.
 */
const myPlanValidation = async (ctx, next) => {
    const valid = querySchema.validate(ctx.request.query || {}, { abortEarly: false, convert: true });
    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    const authUser = ctx.state.user;
    if (!authUser?.session) {
        fail(ctx, 401, "A verified session is required", "ERR_SESSION_REQUIRED");
        return;
    }

    const session = await Session.findById(authUser.session).lean();
    if (!session || session.status !== "active") {
        fail(ctx, 401, "A verified session is required", "ERR_SESSION_REQUIRED");
        return;
    }

    const target = normalizeZelfName(ctx.request.query.zelfName, session.domain || authUser.domain || "zelf");
    const verified = normalizeZelfName(session.verifiedTagName, session.domain || target.domain || "zelf");
    const expired = !session.verifiedUntil || new Date(session.verifiedUntil).getTime() <= Date.now();

    if (!verified.zelfName || expired) {
        fail(ctx, 403, "Session is not verified for this wallet", "ERR_SESSION_NOT_VERIFIED");
        return;
    }

    if (verified.zelfName !== target.zelfName) {
        fail(ctx, 403, "Session is not the owner of this wallet", "ERR_SESSION_OWNER_MISMATCH");
        return;
    }

    ctx.state.verifiedZelfName = target.zelfName;
    await next();
};

module.exports = {
    myPlanValidation,
};
