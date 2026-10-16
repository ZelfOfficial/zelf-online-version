/**
 * zAI auth routes. Mounted on the unprotected router: they carry their own token checks
 * (identity / zAI JWTs use their own secrets, not the session JWT secret).
 */
const ZaiIdentity = require("../modules/zai-identity.module");
const { bearer, sendError, requireZaiToken } = require("../middlewares/zai-auth.middleware");

const config = require("../../../Core/config");

const PATH = config.basePath("/zai");

const identityFrom = (ctx) => ctx.request.body?.identityToken || bearer(ctx);

module.exports = (server) => {
    // Exchange a valid identity token (from decrypt) for a short-lived zAI token.
    server.post(`${PATH}/session`, async (ctx) => {
        try {
            ctx.body = { data: await ZaiIdentity.exchangeForZaiToken(identityFrom(ctx)) };
        } catch (error) {
            sendError(ctx, error);
        }
    });

    // Lock / logout: revoke the identity token and every zAI token derived from it.
    server.post(`${PATH}/revoke`, async (ctx) => {
        try {
            ctx.body = { data: await ZaiIdentity.revokeIdentityToken(identityFrom(ctx)) };
        } catch (error) {
            sendError(ctx, error);
        }
    });

    // Who am I (zAI token only) — smoke test for the /api/zai/* guard.
    server.get(`${PATH}/me`, requireZaiToken, async (ctx) => {
        ctx.body = { data: { zelfName: ctx.state.zai.zelfName, zid: ctx.state.zai.zid, addresses: ctx.state.zai.addresses } };
    });
};
