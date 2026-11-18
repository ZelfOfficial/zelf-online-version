const USER_AGENT_LIMIT = 200;

/**
 * Access log is on unless ACCESS_LOG=false. Read on each request so a process
 * can turn it off without a code change.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
const isAccessLogEnabled = (env = process.env) => {
    const raw = env.ACCESS_LOG;

    if (raw == null) return true;

    return String(raw).trim().toLowerCase() !== "false";
};

const headerValue = (ctx, name) => {
    const value = ctx.get(name);

    return typeof value === "string" ? value.trim() : "";
};

/**
 * Client IP: first X-Forwarded-For hop, then X-Real-IP, then the socket.
 * @param {import("koa").Context} ctx
 * @returns {string}
 */
const clientIp = (ctx) => {
    const forwarded = headerValue(ctx, "x-forwarded-for");

    if (forwarded) {
        const hop = forwarded.split(",")[0].trim();

        if (hop) return hop;
    }

    const realIp = headerValue(ctx, "x-real-ip");

    if (realIp) return realIp;

    return ctx.req?.socket?.remoteAddress || ctx.socket?.remoteAddress || "";
};

const responseBytes = (ctx) => {
    const declared = Number(ctx.length);

    if (Number.isFinite(declared) && declared >= 0) return declared;

    const body = ctx.body;

    if (body == null || body === "") return 0;
    if (Buffer.isBuffer(body)) return body.length;
    if (typeof body === "string") return Buffer.byteLength(body);

    try {
        return Buffer.byteLength(JSON.stringify(body));
    } catch (_error) {
        return 0;
    }
};

const truncate = (value, limit) => {
    const text = typeof value === "string" ? value : "";

    return text.length > limit ? text.slice(0, limit) : text;
};

const writeAccessLog = (ctx, startedNs, status) => {
    const durationMs = Math.max(0, Math.round(Number(process.hrtime.bigint() - startedNs) / 1e6));
    const entry = {
        time: new Date().toISOString(),
        ip: clientIp(ctx),
        method: ctx.method,
        path: ctx.path,
        status: Number(status) || ctx.status,
        durationMs,
        bytes: responseBytes(ctx),
        userAgent: truncate(headerValue(ctx, "user-agent"), USER_AGENT_LIMIT),
    };

    process.stdout.write(`${JSON.stringify(entry)}\n`);
};

/**
 * One JSON line per request. The path has no query string. Headers and bodies are not logged.
 */
const accessLog = () => async (ctx, next) => {
    if (!isAccessLogEnabled()) {
        await next();
        return;
    }

    const startedNs = process.hrtime.bigint();

    try {
        await next();
    } catch (error) {
        const status = Number(error?.status || error?.statusCode) || ctx.status;

        writeAccessLog(ctx, startedNs, status);
        throw error;
    }

    writeAccessLog(ctx, startedNs, ctx.status);
};

module.exports = {
    USER_AGENT_LIMIT,
    isAccessLogEnabled,
    clientIp,
    responseBytes,
    accessLog,
};
