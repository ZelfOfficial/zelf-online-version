/**
 * VaultLegacy Session Controller (Koa)
 * Issues the bearer token for /api/vault-legacy/* endpoints.
 *
 * Android (VerifikWallet) and iOS (Zelf) call POST /api/vault-legacy/sessions
 * with an installation id. See SESSION-PROOF.md for the wallet-signature flow.
 */

const { clientIp } = require("../../../Core/access-log");
const { signToken, TOKEN_TYPES } = require("../../../Core/jwt-claims");
const SessionProof = require("../modules/vault-legacy-session-proof.module");

const requestIp = (ctx) => {
    if (!ctx || typeof ctx.get !== "function") return "";
    try {
        return clientIp(ctx) || "";
    } catch (_error) {
        return "";
    }
};

const legacySecret = () => process.env.LEGACY_JWT_SECRET || process.env.CONNECTION_KEY;

const fail = (ctx, error) => {
    const code = error && error.code ? error.code : "SESSION_FAILED";
    ctx.status = error && error.status ? error.status : 500;
    ctx.body = { error: code, code };
};

/**
 * POST /api/vault-legacy/sessions/challenge
 * Body: { identifier: string, address: string }
 */
const challenge = async (ctx) => {
    try {
        ctx.body = await SessionProof.createChallenge({
            body: ctx.request.body,
            ip: requestIp(ctx),
        });
    } catch (error) {
        fail(ctx, error);
    }
};

/**
 * POST /api/vault-legacy/sessions
 * Legacy body: { identifier }
 * Proven body: { identifier, challengeId, authSig: { sig, signedMessage, address } }
 */
const create = async (ctx) => {
    try {
        const secret = legacySecret();
        if (!secret) {
            ctx.status = 503;
            ctx.body = { error: "SESSION_NOT_CONFIGURED", code: "SESSION_NOT_CONFIGURED" };
            return;
        }

        const issued = await SessionProof.issueSession({
            body: ctx.request.body,
            ip: requestIp(ctx),
        });

        const token = signToken(issued.claims, secret, {
            typ: TOKEN_TYPES.vaultLegacy,
            expiresIn: issued.expiresIn,
        });

        ctx.body = {
            token,
            expiresIn: issued.expiresIn,
            proof: issued.proof,
            ...(issued.address ? { address: issued.address } : {}),
        };
    } catch (error) {
        fail(ctx, error);
    }
};

module.exports = { challenge, create };
