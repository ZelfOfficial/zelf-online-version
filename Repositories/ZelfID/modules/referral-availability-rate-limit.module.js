/**
 * Per-IP cap for the public referral-availability lookup.
 * Same minute budget as the free plan in request-limits (30/min) so a pre-signup
 * check stays cheap to call and expensive to enumerate.
 */
const { codedError } = require("../../../Core/http-handler");

const WINDOW_MS = 60 * 1000;
const buckets = new Map();

const maxPerMinute = () => {
    const n = Number(process.env.REFERRAL_AVAILABILITY_RATE_LIMIT_PER_MINUTE);
    return Number.isInteger(n) && n > 0 ? n : 30;
};

const pruneExpired = (now) => {
    if (buckets.size < 1000) return;
    for (const [key, bucket] of buckets) {
        if (now - bucket.start >= WINDOW_MS) buckets.delete(key);
    }
};

const assertReferralAvailabilityRateLimit = (ip) => {
    const key = String(ip || "").trim() || "unknown";
    const now = Date.now();
    pruneExpired(now);

    let bucket = buckets.get(key);
    if (!bucket || now - bucket.start >= WINDOW_MS) {
        bucket = { start: now, count: 0 };
        buckets.set(key, bucket);
    }

    bucket.count += 1;

    if (bucket.count > maxPerMinute()) {
        const retryAfterSeconds = Math.max(1, Math.ceil((bucket.start + WINDOW_MS - now) / 1000));
        const error = codedError("429:REFERRAL_LOOKUP_RATE_LIMITED");
        error.retryAfterSeconds = retryAfterSeconds;
        throw error;
    }
};

const _resetReferralAvailabilityRateLimit = () => {
    buckets.clear();
};

module.exports = {
    assertReferralAvailabilityRateLimit,
    _resetReferralAvailabilityRateLimit,
};
