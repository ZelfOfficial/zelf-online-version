const jwt = require("jsonwebtoken");
const config = require("../../../Core/config");
const SuperAdmin = require("../models/super-admin.model");
const { TOKEN_TYPES, SUPER_ADMIN_ROLES, normalizeSuperAdminRole, bearerFromHeader } = require("../../../Core/jwt-claims");

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

const resolveEffectiveRole = (admin, decoded) => {
    const adminRole = normalizeSuperAdminRole(admin?.role);
    const tokenRole = normalizeSuperAdminRole(decoded?.role);
    if (adminRole === SUPER_ADMIN_ROLES.blog || tokenRole === SUPER_ADMIN_ROLES.blog) {
        return SUPER_ADMIN_ROLES.blog;
    }
    return SUPER_ADMIN_ROLES.superAdmin;
};

/**
 * Confirms the bearer is a super-admin token, that the account still accepts
 * tokens issued at that time, and that the effective role is in `allowedRoles`.
 */
const requireSuperAdminRoles = (allowedRoles = [SUPER_ADMIN_ROLES.superAdmin]) => {
    const allowedSet = new Set(allowedRoles.map((r) => normalizeSuperAdminRole(r)));

    return async (ctx, next) => {
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

        const effectiveRole = resolveEffectiveRole(admin, decoded);

        if (!allowedSet.has(effectiveRole)) {
            deny(ctx, 403, "SUPER_ADMIN_ROLE_FORBIDDEN");
            return;
        }

        ctx.state.user = { ...decoded, role: effectiveRole };
        ctx.state.superAdmin = admin;

        await next();
    };
};

const verifySuperAdmin = requireSuperAdminRoles([SUPER_ADMIN_ROLES.superAdmin]);
const verifyBlogSuperAdmin = requireSuperAdminRoles([SUPER_ADMIN_ROLES.superAdmin, SUPER_ADMIN_ROLES.blog]);

module.exports = {
    verifySuperAdmin,
    verifyBlogSuperAdmin,
    requireSuperAdminRoles,
    resolveEffectiveRole,
    isInactive,
};
