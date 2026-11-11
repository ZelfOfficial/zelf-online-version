/**
 * VaultLegacy JWT middleware (Koa)
 *
 * Replaces the old X-Zelf-Client-Secret check.
 * Validates a Bearer JWT token signed with LEGACY_JWT_SECRET.
 * The token is issued by POST /api/vault-legacy/sessions.
 */

const jwt = require("jsonwebtoken");
const { TOKEN_TYPES } = require("../../../Core/jwt-claims");

const LEGACY_JWT_SECRET = process.env.LEGACY_JWT_SECRET || process.env.CONNECTION_KEY;

/**
 * Require a valid Bearer JWT in the Authorization header.
 * Attaches the decoded payload to ctx.state.legacyUser.
 */
const requireJWT = async (ctx, next) => {
    const authHeader = ctx.headers["authorization"] || "";
    let token = null;

    if (authHeader.startsWith("Bearer ")) {
        token = authHeader.slice(7).trim();
    }

    if (!token) {
        ctx.status = 401;
        ctx.body = { error: "Authorization header with Bearer token is required" };
        return;
    }

    try {
        const decoded = jwt.verify(token, LEGACY_JWT_SECRET);
        if (decoded.typ !== TOKEN_TYPES.vaultLegacy) {
            ctx.status = 401;
            ctx.body = { error: "INVALID_TOKEN_TYPE", code: "INVALID_TOKEN_TYPE" };
            return;
        }
        ctx.state.legacyUser = decoded;
    } catch (e) {
        ctx.status = 401;
        ctx.body = { error: "Invalid or expired token" };
        return;
    }

    await next();
};

module.exports = { requireJWT };
