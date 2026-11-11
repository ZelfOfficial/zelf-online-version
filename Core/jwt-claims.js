const jwt = require("jsonwebtoken");

/**
 * Claims a caller must not be able to smuggle into a signed payload.
 * Privileged ids are assigned only through signToken options.
 */
const STRIPPED_CLAIMS = ["superAdminId", "staffId", "typ"];

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
 */
const isAcceptedAccessToken = (user, ctx) => {
    if (!user || typeof user !== "object") return false;

    if (typeof user.typ === "string") {
        if (GENERAL_ACCESS.has(user.typ)) return true;
        if (QUOTE_BEARER.has(user.typ) && isQuoteBearerPath(ctx)) return true;
        return false;
    }

    return Number.isFinite(user.exp);
};

const acceptAccessToken = async (ctx, next) => {
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
    GENERAL_ACCESS,
    BLOCKED_PRIVILEGE_TYPES,
    signToken,
    isQuoteBearerPath,
    isAcceptedAccessToken,
    acceptAccessToken,
    isAccountAccessToken,
    bearerFromHeader,
};
