const config = require("../../../Core/config");

const LOCAL_DEV_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

/**
 * When `config.extension.rpc.allowedRequestOrigins` is non-empty, a present
 * `Origin` must be on that list (or localhost outside production).
 *
 * Browsers send `Origin` on cross-origin requests. Native apps never do, and
 * Chrome MV3 with wildcard host_permissions also omits it on GET / HEAD.
 * These routes are mounted after the session JWT, so an authenticated request
 * with no `Origin` is allowed for every method. A request that sends an
 * `Origin` that is not on the list is still rejected.
 *
 * Empty allowlist = no check (backward compatible).
 */
const requireAllowedProtectedRpcOrigin = async (ctx, next) => {
    const allowed = config.extension?.rpc?.allowedRequestOrigins;
    if (!Array.isArray(allowed) || allowed.length === 0) {
        await next();
        return;
    }

    const origin = String(ctx.get("origin") || ctx.headers?.origin || "").trim();
    const method = String(ctx.method || "").toUpperCase();
    const authenticated = Boolean(ctx.state?.user);

    if (!origin && (authenticated || method === "GET" || method === "HEAD")) {
        await next();
        return;
    }

    const isAllowedOrigin =
        Boolean(origin) &&
        (allowed.includes(origin) || (process.env.NODE_ENV !== "production" && LOCAL_DEV_ORIGIN_RE.test(origin)));

    if (!isAllowedOrigin) {
        ctx.status = 403;
        ctx.body = {
            error: "forbidden_origin",
            message: "Protected RPC requests must come from an allowed Origin (e.g. the Zelf extension).",
        };
        return;
    }

    await next();
};

module.exports = {
    requireAllowedProtectedRpcOrigin,
};
