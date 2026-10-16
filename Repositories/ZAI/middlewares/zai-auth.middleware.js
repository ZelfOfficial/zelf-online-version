const ZaiIdentity = require("../modules/zai-identity.module");

const bearer = (ctx) => {
    const header = ctx.headers?.authorization || "";
    const match = header.match(/^(?:Bearer|JWT)\s+(.+)$/i);
    return match ? match[1].trim() : null;
};

const sendError = (ctx, error) => {
    ctx.status = error.status || 500;
    ctx.body = { code: error.code || "ZAI_ERROR", message: error.message };
};

/** /api/zai/* guard: only zAI tokens (typ=zai, scope zai:chat). Normal session JWTs and identity tokens get 403. */
const requireZaiToken = async (ctx, next) => {
    try {
        const claims = await ZaiIdentity.verifyZaiToken(bearer(ctx));
        ctx.state.zai = { zelfName: claims.sub, zid: claims.zid, addresses: claims.addr || {}, jti: claims.jti, parentJti: claims.parent_jti };
    } catch (error) {
        return sendError(ctx, error);
    }
    return next();
};

module.exports = { bearer, sendError, requireZaiToken };
