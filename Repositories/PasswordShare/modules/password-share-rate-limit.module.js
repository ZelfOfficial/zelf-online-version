/**
 * Per-IP (and, for creation, per session identifier) caps.
 * Same in-memory minute window as the public referral-availability lookup.
 * The API process does not have a shared rate-limit middleware; this matches
 * the limiter that feature already uses.
 */
const { codedError } = require("../../../Core/http-handler");

const WINDOW_MS = 60 * 1000;
const buckets = new Map();

const LIMITS = {
	create: { env: "PASSWORD_SHARE_CREATE_RATE_LIMIT_PER_MINUTE", fallback: 30 },
	metadata: { env: "PASSWORD_SHARE_METADATA_RATE_LIMIT_PER_MINUTE", fallback: 60 },
	reveal: { env: "PASSWORD_SHARE_REVEAL_RATE_LIMIT_PER_MINUTE", fallback: 20 },
};

const maxPerMinute = (kind) => {
	const spec = LIMITS[kind];
	const n = Number(process.env[spec.env]);
	return Number.isInteger(n) && n > 0 ? n : spec.fallback;
};

const pruneExpired = (now) => {
	if (buckets.size < 1000) return;
	for (const [key, bucket] of buckets) {
		if (now - bucket.start >= WINDOW_MS) buckets.delete(key);
	}
};

/**
 * @param {"create"|"metadata"|"reveal"} kind
 * @param {string} ip
 * @param {string} [identifier] session identifier; creation is keyed by it when present
 */
const assertPasswordShareRateLimit = (kind, ip, identifier) => {
	if (!LIMITS[kind]) return;

	const subject = kind === "create" && identifier ? String(identifier).trim() : "";
	const key = `${kind}:${subject || String(ip || "").trim() || "unknown"}`;
	const now = Date.now();
	pruneExpired(now);

	let bucket = buckets.get(key);
	if (!bucket || now - bucket.start >= WINDOW_MS) {
		bucket = { start: now, count: 0 };
		buckets.set(key, bucket);
	}

	bucket.count += 1;

	if (bucket.count > maxPerMinute(kind)) {
		const retryAfterSeconds = Math.max(1, Math.ceil((bucket.start + WINDOW_MS - now) / 1000));
		const error = codedError("429:PASSWORD_SHARE_RATE_LIMITED");
		error.status = 429;
		error.retryAfterSeconds = retryAfterSeconds;
		throw error;
	}
};

const _resetPasswordShareRateLimit = () => {
	buckets.clear();
};

module.exports = {
	assertPasswordShareRateLimit,
	_resetPasswordShareRateLimit,
	LIMITS,
};
