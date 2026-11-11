/**
 * VaultLegacy Session Controller (Koa)
 * Issues a short-lived JWT that authenticates all /api/vault-legacy/* endpoints.
 *
 * The Android app calls POST /api/vault-legacy/sessions with its
 * identifier (installation ID or wallet address) to get a Bearer token.
 */

const { signToken, TOKEN_TYPES } = require("../../../Core/jwt-claims");

const LEGACY_JWT_SECRET = process.env.LEGACY_JWT_SECRET || process.env.CONNECTION_KEY;
// Token valid for 24 hours — long enough for an app session
const TOKEN_TTL_SECONDS = 60 * 60 * 24;

/**
 * POST /api/vault-legacy/sessions
 * Body: { identifier: string }
 * Returns: { token: string, expiresIn: number }
 */
const create = async (ctx) => {
    try {
        const { identifier } = ctx.request.body || {};

        if (!identifier) {
            ctx.status = 400;
            ctx.body = { error: "identifier is required" };
            return;
        }

        const token = signToken(
            {
                identifier,
                type: "vault-legacy",
                iat: Math.floor(Date.now() / 1000),
            },
            LEGACY_JWT_SECRET,
            { typ: TOKEN_TYPES.vaultLegacy, expiresIn: TOKEN_TTL_SECONDS }
        );

        ctx.body = {
            token,
            expiresIn: TOKEN_TTL_SECONDS,
        };
    } catch (error) {
        ctx.status = error.status || 500;
        ctx.body = { error: error.message };
    }
};

module.exports = { create };
