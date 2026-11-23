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
const deny = (ctx, code) => {
    ctx.status = 401;
    ctx.body = { error: code, code };
};

const requireJWT = async (ctx, next) => {
    const authHeader = ctx.headers["authorization"] || "";
    let token = null;

    if (authHeader.startsWith("Bearer ")) {
        token = authHeader.slice(7).trim();
    }

    if (!token) {
        deny(ctx, "MISSING_AUTHORIZATION");
        return;
    }

    if (!LEGACY_JWT_SECRET) {
        deny(ctx, "INVALID_TOKEN");
        return;
    }

    try {
        const decoded = jwt.verify(token, LEGACY_JWT_SECRET);
        if (decoded.typ !== TOKEN_TYPES.vaultLegacy) {
            deny(ctx, "INVALID_TOKEN_TYPE");
            return;
        }
        if (typeof decoded.identifier !== "string" || decoded.identifier.trim() === "") {
            deny(ctx, "INVALID_TOKEN");
            return;
        }
        ctx.state.legacyUser = decoded;
    } catch (_error) {
        deny(ctx, "INVALID_TOKEN");
        return;
    }

    await next();
};

module.exports = { requireJWT };
