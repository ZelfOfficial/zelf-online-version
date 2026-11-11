const jwt = require("jsonwebtoken");
const config = require("../../../Core/config");
const SuperAdmin = require("../models/super-admin.model");
const { TOKEN_TYPES, bearerFromHeader } = require("../../../Core/jwt-claims");

const deny = (ctx, status, code) => {
    ctx.status = status;
    ctx.body = { error: code, code };
};

const isInactive = (admin) => {
    if (!admin) return true;
    if (admin.disabled === true) return true;
    if (admin.active === false) return true;
    return admin.status === "banned" || admin.status === "inactive";
};

/**
 * Confirms the bearer is a super-admin token and that the account
 * still accepts tokens issued at that time.
 */
const verifySuperAdmin = async (ctx, next) => {
    const token = bearerFromHeader(ctx.headers?.authorization || ctx.header?.authorization || "");

    if (!token) {
        deny(ctx, 401, "SUPER_ADMIN_REQUIRED");
        return;
    }

    let decoded;

    try {
        decoded = jwt.verify(token, config.JWT_SECRET);
    } catch (error) {
        deny(ctx, 401, "INVALID_TOKEN");
        return;
    }

    if (decoded.typ !== TOKEN_TYPES.superAdmin || !decoded.superAdminId) {
        deny(ctx, 403, "SUPER_ADMIN_REQUIRED");
        return;
    }

    const admin = await SuperAdmin.findById(decoded.superAdminId);

    if (!admin) {
        deny(ctx, 403, "SUPER_ADMIN_NOT_FOUND");
        return;
    }

    if (isInactive(admin)) {
        deny(ctx, 403, "SUPER_ADMIN_INACTIVE");
        return;
    }

    const currentVersion = Number(admin.tokenVersion || 0);
    const tokenVersion = Number(decoded.tokenVersion || 0);

    if (tokenVersion !== currentVersion) {
        deny(ctx, 403, "TOKEN_REVOKED");
        return;
    }

    if (admin.tokensValidAfter) {
        const validAfter = Math.floor(new Date(admin.tokensValidAfter).getTime() / 1000);
        const issuedAt = Number(decoded.iat);

        if (!Number.isFinite(issuedAt) || issuedAt < validAfter) {
            deny(ctx, 403, "TOKEN_REVOKED");
            return;
        }
    }

    ctx.state.user = decoded;
    ctx.state.superAdmin = admin;

    await next();
};

module.exports = {
    verifySuperAdmin,
    isInactive,
};
