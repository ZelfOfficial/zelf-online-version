/**
 * Angela webhook transport: send a question to Angela's routine webhook, accept her signed callback,
 * and let any process wait for / read the answer through Mongo (zai_requests).
 * Env: ZAI_ANGELA_WEBHOOK_URL, ZAI_ANGELA_WEBHOOK_KEY, ZAI_CALLBACK_SECRET (all required, else 503 ZAI_DISABLED).
 */
const crypto = require("crypto");
const ZaiRequest = require("../models/zai-request.model");
const { redactText } = require("./zai-redaction.module");

const CALLBACK_URL = process.env.ZAI_CALLBACK_URL || "https://v4.zelf.world/api/zai/callback";
const REPLY_WINDOW_MS = Math.max(180 * 1000, Number(process.env.ZAI_REPLY_WINDOW_MS) || 0); // Angela's deadline: ≥ 3 min (her runs queue)
const WAIT_TIMEOUT_MS = Number(process.env.ZAI_WAIT_TIMEOUT_MS) || REPLY_WINDOW_MS + 20 * 1000; // SSE gives up (≈200 s) → ZAI_TIMEOUT
const POLL_MS = Number(process.env.ZAI_POLL_MS || 1000);
const RESULT_TTL_MS = 60 * 60 * 1000;
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;

const zaiError = (status, code) => {
    const error = new Error(`${status}:${code}`);
    error.status = status;
    error.code = code;
    error.clientCode = code;
    error.clientMessage = code;
    return error;
};

const isEnabled = () => !!(process.env.ZAI_ANGELA_WEBHOOK_URL && process.env.ZAI_ANGELA_WEBHOOK_KEY && process.env.ZAI_CALLBACK_SECRET);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Create the pending request record (owned by the token's Zelf ID). */
const createRequest = async ({ requestId, zelfName, rulesVersion, cards }) => {
    const now = Date.now();
    const replyDeadline = new Date(now + REPLY_WINDOW_MS);
    await ZaiRequest.create({ requestId, zelfName, rulesVersion, cards, replyDeadline, expiresAt: new Date(now + RESULT_TTL_MS) });
    return { replyDeadline };
};

/** POST the payload to Angela; retries up to 3 times on 408/429/5xx/network errors with backoff. */
const sendToAngela = async (payload, { fetchImpl = globalThis.fetch, backoffMs = 500, signal } = {}) => {
    const url = process.env.ZAI_ANGELA_WEBHOOK_URL;
    const key = process.env.ZAI_ANGELA_WEBHOOK_KEY;
    let lastStatus = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt) await sleep(backoffMs * 2 ** (attempt - 1));
        if (signal?.aborted) break;
        try {
            const res = await fetchImpl(url, {
                method: "POST",
                signal,
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
                body: JSON.stringify(payload),
            });
            if (res.ok) return { attempts: attempt + 1 };
            lastStatus = res.status;
            if (!RETRY_STATUSES.has(res.status)) break;
        } catch (_) {
            lastStatus = "network";
        }
    }
    throw Object.assign(zaiError(502, "ZAI_UPSTREAM_ERROR"), { upstreamStatus: lastStatus });
};

const markFailed = (requestId) => ZaiRequest.updateOne({ requestId, status: "pending" }, { $set: { status: "failed" } });

/** Timing-safe HMAC-SHA256(raw body, ZAI_CALLBACK_SECRET); accepts "hex" or "sha256=hex". */
const verifySignature = (rawBody, header) => {
    const secret = process.env.ZAI_CALLBACK_SECRET;
    if (!secret || typeof rawBody !== "string" || !header) return false;
    const given = String(header).trim().replace(/^sha256=/i, "");
    if (!/^[0-9a-f]{64}$/i.test(given)) return false;
    const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest();
    return crypto.timingSafeEqual(expected, Buffer.from(given, "hex"));
};

/** Store Angela's (redacted) answer: only for a known, unexpired, still-pending requestId. Atomic. */
const recordAnswer = async ({ requestId, text }) => {
    const now = new Date();
    const clean = redactText(String(text));
    const updated = await ZaiRequest.findOneAndUpdate(
        { requestId, status: "pending", replyDeadline: { $gt: now } },
        { $set: { status: "answered", text: clean.text, filtered: clean.hits.length > 0, answeredAt: now } },
        { new: true }
    ).lean();
    if (!updated) {
        // No-op for anything we can't accept: duplicates → 409, late/unknown/failed → 410.
        const doc = await ZaiRequest.findOne({ requestId }, { status: 1 }).lean();
        if (doc?.status === "answered") throw zaiError(409, "ZAI_ALREADY_ANSWERED");
        throw zaiError(410, "ZAI_REQUEST_EXPIRED");
    }
    return { accepted: true, requestId };
};

/** Poll Mongo until answered/failed or timeout (works across processes). */
const waitForAnswer = async (requestId, { signal, timeoutMs = WAIT_TIMEOUT_MS, pollMs = POLL_MS } = {}) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        if (signal?.aborted) return { status: "aborted" };
        const doc = await ZaiRequest.findOne({ requestId }, { status: 1, text: 1, filtered: 1 }).lean();
        if (doc?.status === "answered") return { status: "answered", text: doc.text, filtered: !!doc.filtered };
        if (doc?.status === "failed") return { status: "failed" };
        await sleep(pollMs);
    }
    return { status: "timeout" };
};

/** Result pickup after a dropped stream: same Zelf ID only (others get 404, no existence leak). */
const getResult = async (requestId, zai) => {
    const doc = await ZaiRequest.findOne({ requestId, zelfName: zai.zelfName }).lean();
    if (!doc) throw zaiError(404, "ZAI_RESULT_NOT_FOUND");
    const expired = doc.status === "pending" && new Date(doc.replyDeadline) < new Date();
    return {
        requestId,
        status: expired ? "timeout" : doc.status,
        rulesVersion: doc.rulesVersion,
        text: doc.status === "answered" ? doc.text : null,
        cards: doc.status === "answered" ? doc.cards : [],
    };
};

module.exports = {
    CALLBACK_URL,
    WAIT_TIMEOUT_MS,
    isEnabled,
    zaiError,
    createRequest,
    sendToAngela,
    markFailed,
    verifySignature,
    recordAnswer,
    waitForAnswer,
    getResult,
};
