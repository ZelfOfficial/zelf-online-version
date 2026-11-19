const jwt = require("jsonwebtoken");

/**
 * Claims a caller must not be able to smuggle into a signed payload.
 * Privileged ids are assigned only through signToken options.
 */
const STRIPPED_CLAIMS = ["superAdminId", "superAdminRole", "staffId", "typ"];

const TOKEN_TYPES = {
    session: "session",
    client: "client",
    staff: "staff",
    lawyer: "lawyer",
    superAdmin: "super_admin",
    duration: "duration",
    quote: "quote",
    record: "record",
    purchase: "purchase",
    priceLock: "price_lock",
    staffInvitation: "staff_invitation",
    lawyerInvitation: "lawyer_invitation",
    vaultLegacy: "vault_legacy",
    /** Face-check owner grant. Not a session or bearer token. */
    ownerGrant: "owner_grant",
};

const SUPER_ADMIN_ROLES = {
    superAdmin: "super_admin",
    blog: "blog",
};

const BLOG_ROLE_ALIASES = new Set(["blog", "blogs", "blog_admin", "blog_editor"]);

const normalizeSuperAdminRole = (role) => {
    if (typeof role !== "string") return SUPER_ADMIN_ROLES.superAdmin;
    const normalized = role.trim().toLowerCase();
    if (BLOG_ROLE_ALIASES.has(normalized)) return SUPER_ADMIN_ROLES.blog;
    return SUPER_ADMIN_ROLES.superAdmin;
};

const isBlogOnlySuperAdmin = (user) => {
    if (!user || typeof user !== "object") return false;
    if (user.typ !== TOKEN_TYPES.superAdmin && !user.superAdminId) return false;
    return normalizeSuperAdminRole(user.role || user.superAdminRole) === SUPER_ADMIN_ROLES.blog;
};

const isBlogSuperAdminPath = (ctx) => {
    const rawPath = String(ctx?.path || ctx?.request?.path || ctx?.url || "").split("?")[0];
    return rawPath === "/api/blogs" || rawPath.startsWith("/api/blogs/");
};

/** Bearer tokens that may call ordinary protected routes. */
const GENERAL_ACCESS = new Set([
    TOKEN_TYPES.session,
    TOKEN_TYPES.client,
    TOKEN_TYPES.staff,
    TOKEN_TYPES.lawyer,
    TOKEN_TYPES.superAdmin,
    TOKEN_TYPES.duration,
]);

/**
 * Price JWTs are the Authorization credential for ZNS renew.
 * They are not accepted on any other protected route.
 */
const QUOTE_BEARER = new Set([TOKEN_TYPES.quote, TOKEN_TYPES.record]);
const QUOTE_BEARER_PATHS = ["/my-zelf-name/renew"];

const BLOCKED_PRIVILEGE_TYPES = new Set([
    TOKEN_TYPES.quote,
    TOKEN_TYPES.record,
    TOKEN_TYPES.purchase,
    TOKEN_TYPES.priceLock,
    TOKEN_TYPES.staffInvitation,
    TOKEN_TYPES.lawyerInvitation,
    TOKEN_TYPES.vaultLegacy,
    "monthly_access",
    "identity",
    "zai",
    TOKEN_TYPES.ownerGrant,
]);

const signToken = (payload, secret, options = {}) => {
    if (!options.typ || typeof options.typ !== "string") {
        throw new Error("JWT_TYP_REQUIRED");
    }

    const claims = { ...(payload || {}) };

    for (const key of STRIPPED_CLAIMS) {
        delete claims[key];
    }

    claims.typ = options.typ;

    if (options.superAdminId) {
        claims.superAdminId = options.superAdminId;
    }

    if (options.typ === TOKEN_TYPES.superAdmin) {
        claims.role = normalizeSuperAdminRole(options.role || payload?.role);
    }

    if (options.staffId) {
        claims.staffId = options.staffId;
    }

    const signOptions = {};

    if (options.expiresIn != null && claims.exp == null) {
        signOptions.expiresIn = options.expiresIn;
    }

    if (options.algorithm) {
        signOptions.algorithm = options.algorithm;
    }

    return jwt.sign(claims, secret, signOptions);
};

const isQuoteBearerPath = (ctx) => {
    const path = String(ctx?.path || ctx?.request?.path || ctx?.url || "");
    return QUOTE_BEARER_PATHS.some((part) => path.includes(part));
};

/**
 * Legacy tokens (no typ) stay valid only when they already expire.
 * Tokens with neither typ nor exp are rejected.
 * Blog-scoped super-admin tokens may only access /api/blogs routes.
 */
const isAcceptedAccessToken = (user, ctx) => {
    if (!user || typeof user !== "object") return false;

    if (isBlogOnlySuperAdmin(user) && !isBlogSuperAdminPath(ctx)) {
        return false;
    }

    if (typeof user.typ === "string") {
        if (GENERAL_ACCESS.has(user.typ)) return true;
        if (QUOTE_BEARER.has(user.typ) && isQuoteBearerPath(ctx)) return true;
        return false;
    }

    return Number.isFinite(user.exp);
};

const acceptAccessToken = async (ctx, next) => {
    if (isBlogOnlySuperAdmin(ctx.state.user) && !isBlogSuperAdminPath(ctx)) {
        ctx.status = 403;
        ctx.body = { error: "SUPER_ADMIN_ROLE_FORBIDDEN", code: "SUPER_ADMIN_ROLE_FORBIDDEN" };
        return;
    }

    if (!isAcceptedAccessToken(ctx.state.user, ctx)) {
        ctx.status = 401;
        ctx.body = { error: "INVALID_TOKEN_TYPE", code: "INVALID_TOKEN_TYPE" };
        return;
    }

    await next();
};

const isAccountAccessToken = (user) => {
    if (!user || typeof user !== "object") return false;
    if (user.typ === TOKEN_TYPES.client || user.typ === TOKEN_TYPES.staff || user.typ === TOKEN_TYPES.lawyer) return true;
    return !user.typ && Number.isFinite(user.exp);
};

const bearerFromHeader = (header) => {
    if (!header || typeof header !== "string") return null;
    const value = header.trim();
    if (!value) return null;

    const ey = value.indexOf("ey");
    if (ey !== -1) return value.substring(ey);

    const parts = value.split(" ");
    return parts.length > 1 ? parts[1] : value;
};

module.exports = {
    STRIPPED_CLAIMS,
    TOKEN_TYPES,
    SUPER_ADMIN_ROLES,
    GENERAL_ACCESS,
    BLOCKED_PRIVILEGE_TYPES,
    signToken,
    normalizeSuperAdminRole,
    isBlogOnlySuperAdmin,
    isBlogSuperAdminPath,
    isQuoteBearerPath,
    isAcceptedAccessToken,
    acceptAccessToken,
    isAccountAccessToken,
    bearerFromHeader,
};
