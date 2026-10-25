const { string, validate } = require("../../../Core/JoiUtils");
const FaceSecurity = require("../modules/face-security.module");
const nonceIssueSchema = {
    action: string().required(),
    /** Legacy / ignored for binding; server resolves `bindingIdentifier` from JWT + body. */
    identifier: string().optional(),
};

const nonceIssueValidation = async (ctx, next) => {
    const { action, identifier } = ctx.request.body || {};
    const valid = validate(nonceIssueSchema, { action, identifier });
    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }
    await next();
};

/**
 * Factory for Koa middleware that guards face endpoints.
 * @param {string} action - logical action key (decrypt, lease, store-zotp, …)
 */
const gate = (action) => async (ctx, next) => {
    const allowed = await FaceSecurity.runFaceSecurityPre(ctx, action);
    if (!allowed) {
        return;
    }

    if (ctx.status === 429 && ctx.body?.code === "face_locked") {
        const retryAfter = ctx.body.retryAfter || ctx.get("Retry-After");
        if (retryAfter) ctx.set("Retry-After", String(retryAfter));
    }

    try {
        await next();
    } finally {
        await FaceSecurity.runFaceSecurityPost(ctx);
    }
};

const handleFaceSecurityError = (ctx, err) => {
    if (err?.clientCode === "face_locked" || err?.status === 429) {
        const retryAfter = err.retryAfterSeconds || 60;
        ctx.status = 429;
        ctx.set("Retry-After", String(retryAfter));
        ctx.body = {
            message: "Too many failed face attempts",
            code: "face_locked",
            retryAfter,
        };
        return true;
    }
    if (err?.clientCode === "face_pow_unconfigured" || /face_pow_unconfigured/.test(String(err?.message || ""))) {
        ctx.status = 503;
        ctx.body = {
            message: "Face verification is temporarily unavailable",
            code: "face_pow_unconfigured",
        };
        return true;
    }
    if (err?.clientCode === "face_replay_detected") {
        ctx.status = 409;
        ctx.body = {
            message: err.clientMessage || "Face replay detected",
            code: "face_replay_detected",
            clientMessage: err.clientMessage,
        };
        return true;
    }
    return false;
};

const wrapGate = (action) => async (ctx, next) => {
    try {
        await gate(action)(ctx, next);
    } catch (err) {
        if (handleFaceSecurityError(ctx, err)) return;
        throw err;
    }
};

/** Run face security only when `faceBase64` is present (e.g. BlockDAG zelf wallet auth). */
const gateIfFace = (action) => async (ctx, next) => {
    const face = ctx.request.body?.faceBase64;
    if (face == null || String(face).trim() === "") {
        await next();
        return;
    }
    return wrapGate(action)(ctx, next);
};

module.exports = {
    nonceIssueValidation,
    gate: wrapGate,
    gateIfFace,
    /** @deprecated use gate */
    faceGate: wrapGate,
};
