const config = require("../../../Core/config");

const LOCAL_DEV_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

/**
 * When `config.extension.rpc.allowedRequestOrigins` is non-empty, only those
 * `Origin` header values may call GET/POST /api/protected/rpc/* (e.g. chrome-extension://<id>).
 *
 * Note: In Chrome Extensions (MV3) with wildcard host_permissions, Chromium omits the
 * `Origin` header on `GET` / `HEAD` requests (e.g. Stellar Horizon and Bitcoin Blockbook reads),
 * while cross-origin web pages (`https://...`) always send `Origin` on CORS requests with
 * `Authorization`. Therefore, authenticated `GET` / `HEAD` requests without an `Origin` header
 * are permitted, while any present `Origin` must match the allowlist (or localhost in non-prod).
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

    if (!origin && (method === "GET" || method === "HEAD")) {
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
