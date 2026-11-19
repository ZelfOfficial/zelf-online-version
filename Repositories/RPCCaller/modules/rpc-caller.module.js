const crypto = require("crypto");
const config = require("../../../Core/config");
const RpcCaller = require("../models/rpc-caller.model");
const RpcCallerWindow = require("../models/rpc-caller-window.model");

const normalizeIp = (ip) => {
    if (ip == null || ip === "") {
        return null;
    }
    const s = String(ip).trim();
    return s.length ? s : null;
};

const assertNotBanned = async (ip) => {
    const normalized = normalizeIp(ip);
    if (!normalized) {
        return;
    }

    const row = await RpcCaller.findOne({ ip: normalized }).select("banned").lean();
    if (row?.banned) {
        const error = new Error("RPC access denied for this network");
        error.status = 403;
        error.clientCode = "rpc_caller_banned";
        throw error;
    }
};

const utcMinuteStart = () => new Date(Math.floor(Date.now() / 60000) * 60000);

const rateLimitError = (retryAfterSeconds) => {
    const error = new Error("RPC rate limit exceeded");
    error.status = 429;
    error.clientCode = "rpc_rate_limited";
    error.retryAfterSeconds = retryAfterSeconds;
    return error;
};

const userSubject = (userKey) => {
    const digest = crypto.createHash("sha256").update(String(userKey)).digest("hex").slice(0, 32);
    return `u:${digest}`;
};

/**
 * Mongo-backed burst detection: per UTC minute bucket + optional rolling sum.
 * Increments the current window before enforcing limits (counts this request).
 * `options.userKey` (JWT identifier or session id) is counted in a separate bucket.
 */
const consumeWindow = async (subject, { maxPerMinute, rollingMinutes, maxRolling, ttlMs, count = 1 }) => {
    const increment = Math.max(1, Math.floor(Number(count) || 1));
    const windowStart = utcMinuteStart();
    const expiresAt = new Date(windowStart.getTime() + ttlMs);

    const updated = await RpcCallerWindow.findOneAndUpdate(
        { ip: subject, windowStart },
        {
            $inc: { count: increment },
            $setOnInsert: { expiresAt },
        },
        { upsert: true, new: true }
    ).lean();

    if (updated.count > maxPerMinute) {
        throw rateLimitError(60);
    }

    if (maxRolling > 0) {
        const cutoff = new Date(Date.now() - rollingMinutes * 60 * 1000);
        const agg = await RpcCallerWindow.aggregate([
            { $match: { ip: subject, windowStart: { $gte: cutoff } } },
            { $group: { _id: null, total: { $sum: "$count" } } },
        ]);
        const rollingTotal = agg[0]?.total || 0;
        if (rollingTotal > maxRolling) {
            throw rateLimitError(rollingMinutes * 60);
        }
    }
};

const assertWithinRateLimit = async (ip, options = {}) => {
    const rl = config.rpc?.rateLimit;
    if (!rl?.enabled) {
        return;
    }

    const rollingMinutes = Math.max(1, Number(rl.rollingMinutes) || 5);
    const ttlMs = Math.max(60000, Number(rl.windowTtlMs) || 2 * 60 * 60 * 1000);
    const ipMaxPerMinute = Math.max(1, Number(rl.maxPerMinute) || 300);
    const ipMaxRolling = Math.max(0, Number(rl.maxInRollingWindow) || 0);
    const userMaxPerMinute = Math.max(1, Number(process.env.RPC_RATE_LIMIT_PER_USER_PER_MINUTE) || ipMaxPerMinute);
    const userMaxRolling = Math.max(0, Number(process.env.RPC_RATE_LIMIT_PER_USER_MAX_ROLLING) || ipMaxRolling);

    const normalized = normalizeIp(ip);
    if (normalized) {
        await consumeWindow(normalized, {
            maxPerMinute: ipMaxPerMinute,
            rollingMinutes,
            maxRolling: ipMaxRolling,
            ttlMs,
        });
    }

    if (options.userKey) {
        await consumeWindow(userSubject(options.userKey), {
            maxPerMinute: userMaxPerMinute,
            rollingMinutes,
            maxRolling: userMaxRolling,
            ttlMs,
        });
    }
};

const positiveInt = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
};

/** Distinct from the raw-IP bucket. Fits RpcCallerWindow.ip (max 45). */
const sessionlessSubject = (ip) => {
    const digest = crypto.createHash("sha256").update(String(ip)).digest("hex").slice(0, 32);
    return `s:${digest}`;
};

const SESSIONLESS_GLOBAL_SUBJECT = "s:global";

const sessionlessLimitConfig = (env = process.env) => ({
    perMinute: positiveInt(env.RPC_SESSIONLESS_PER_IP_PER_MINUTE, 60),
    perHour: positiveInt(env.RPC_SESSIONLESS_PER_IP_PER_HOUR, 600),
    globalPerMinute: positiveInt(env.RPC_SESSIONLESS_GLOBAL_PER_MINUTE, 2000),
});

/**
 * Separate buckets for the compatibility lane: `s:<hash>` per IP and `s:global`.
 * `count` is the number of JSON-RPC calls in the request (a batch counts each item).
 * Always enforced for that lane, including when RPC_RATE_LIMIT_ENABLED=false.
 */
const assertWithinSessionlessRateLimit = async (ip, count = 1) => {
    const normalized = normalizeIp(ip);
    if (!normalized) {
        const error = new Error("Client address is required");
        error.status = 400;
        error.clientCode = "RPC_SESSIONLESS_IP_REQUIRED";
        throw error;
    }

    const limits = sessionlessLimitConfig();
    const ttlMs = Math.max(60000, Number(config.rpc?.rateLimit?.windowTtlMs) || 2 * 60 * 60 * 1000);
    const increment = Math.max(1, Math.floor(Number(count) || 1));

    try {
        await consumeWindow(sessionlessSubject(normalized), {
            maxPerMinute: limits.perMinute,
            rollingMinutes: 60,
            maxRolling: limits.perHour,
            ttlMs,
            count: increment,
        });
        await consumeWindow(SESSIONLESS_GLOBAL_SUBJECT, {
            maxPerMinute: limits.globalPerMinute,
            rollingMinutes: 1,
            maxRolling: 0,
            ttlMs,
            count: increment,
        });
    } catch (error) {
        if (error?.clientCode === "rpc_rate_limited") {
            error.clientCode = "RPC_SESSIONLESS_RATE_LIMITED";
            error.message = "RPC rate limit exceeded";
        }
        throw error;
    }
};

const recordRequest = (ip) => {
    const normalized = normalizeIp(ip);
    if (!normalized) {
        return;
    }

    const now = new Date();
    void RpcCaller.findOneAndUpdate(
        { ip: normalized },
        {
            $inc: { requestCount: 1 },
            $set: { lastSeenAt: now },
            $setOnInsert: {
                firstSeenAt: now,
                banned: false,
            },
        },
        { upsert: true }
    ).catch((err) => {
        console.error("[RPC caller] counter update failed", err?.message || err);
    });
};

const listTopByVolume = async ({ limit = 50, skip = 0 } = {}) => {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const safeSkip = Math.max(Number(skip) || 0, 0);

    const [items, total] = await Promise.all([
        RpcCaller.find({})
            .sort({ requestCount: -1 })
            .skip(safeSkip)
            .limit(safeLimit)
            .select("ip requestCount firstSeenAt lastSeenAt banned bannedAt bannedReason")
            .lean(),
        RpcCaller.countDocuments({}),
    ]);

    return { items, total, limit: safeLimit, skip: safeSkip };
};

const banIp = async (ip, reason = null) => {
    const normalized = normalizeIp(ip);
    if (!normalized) {
        const error = new Error("Invalid IP");
        error.status = 400;
        throw error;
    }

    const now = new Date();
    const doc = await RpcCaller.findOneAndUpdate(
        { ip: normalized },
        {
            $set: {
                banned: true,
                bannedAt: now,
                bannedReason: reason ? String(reason).slice(0, 500) : null,
            },
            $setOnInsert: {
                firstSeenAt: now,
                lastSeenAt: now,
                requestCount: 0,
            },
        },
        { upsert: true, new: true }
    ).lean();

    return doc;
};

const unbanIp = async (ip) => {
    const normalized = normalizeIp(ip);
    if (!normalized) {
        const error = new Error("Invalid IP");
        error.status = 400;
        throw error;
    }

    const doc = await RpcCaller.findOneAndUpdate(
        { ip: normalized },
        {
            $set: {
                banned: false,
                bannedAt: null,
                bannedReason: null,
            },
        },
        { new: true }
    ).lean();

    if (!doc) {
        const error = new Error("IP not found");
        error.status = 404;
        throw error;
    }

    return doc;
};

module.exports = {
    normalizeIp,
    userSubject,
    sessionlessSubject,
    SESSIONLESS_GLOBAL_SUBJECT,
    assertNotBanned,
    assertWithinRateLimit,
    assertWithinSessionlessRateLimit,
    recordRequest,
    listTopByVolume,
    banIp,
    unbanIp,
};
