/**
 * Per-IP cap for super-admin OTP request and verify.
 * Same in-memory window as the referral lookup limiter.
 */
const WINDOW_MS = 60 * 1000;
const buckets = new Map();

const maxPerMinute = () => {
    const n = Number(process.env.SUPER_ADMIN_OTP_RATE_LIMIT_PER_MINUTE);
    return Number.isInteger(n) && n > 0 ? n : 5;
};

const pruneExpired = (now) => {
    if (buckets.size < 1000) return;
    for (const [key, bucket] of buckets) {
        if (now - bucket.start >= WINDOW_MS) buckets.delete(key);
    }
};

const assertSuperAdminOtpRateLimit = (ip, action) => {
    const key = `${action || "otp"}:${String(ip || "").trim() || "unknown"}`;
    const now = Date.now();
    pruneExpired(now);

    let bucket = buckets.get(key);
    if (!bucket || now - bucket.start >= WINDOW_MS) {
        bucket = { start: now, count: 0 };
        buckets.set(key, bucket);
    }

    bucket.count += 1;

    if (bucket.count > maxPerMinute()) {
        const error = new Error("429:OTP_RATE_LIMITED");
        error.status = 429;
        error.code = "OTP_RATE_LIMITED";
        error.retryAfterSeconds = Math.max(1, Math.ceil((bucket.start + WINDOW_MS - now) / 1000));
        throw error;
    }
};

const _resetSuperAdminOtpRateLimit = () => {
    buckets.clear();
};

module.exports = {
    assertSuperAdminOtpRateLimit,
    _resetSuperAdminOtpRateLimit,
};
