/**
 * Proof of control for POST /api/vault-legacy/sessions.
 *
 * Android (VerifikWallet) and iOS (Zelf) currently post an installation id and
 * receive a 24-hour token. That path stays available while
 * VAULT_LEGACY_SESSION_PROOF=legacy (the default). A caller that presents an
 * EIP-191 signature over a server challenge receives a token bound to that wallet.
 */

const crypto = require("crypto");
const { ethers } = require("ethers");
const mongoose = require("mongoose");

const Challenge = require("../models/vault-legacy-session-challenge.model");

const LEGACY_SESSION_TTL_SECONDS = 60 * 60 * 24;
const DEFAULT_PROVEN_TTL_SECONDS = 60 * 60;
const DEFAULT_CHALLENGE_TTL_SECONDS = 300;
const DEFAULT_CHALLENGE_PER_MINUTE = 30;
const DEFAULT_SESSION_PER_MINUTE = 60;
const IDENTIFIER_MAX = 128;
const MINUTE_MS = 60 * 1000;

const memoryChallenges = new Map();
const windows = new Map();

const sessionError = (code, status) => {
    const error = new Error(code);
    error.code = code;
    error.status = status;
    return error;
};

const sessionProofMode = (env = process.env) => {
    const raw = String(env.VAULT_LEGACY_SESSION_PROOF ?? "legacy")
        .trim()
        .toLowerCase();
    return raw === "required" ? "required" : "legacy";
};

const boundedInt = (value, fallback, min, max) => {
    const n = Number(value);
    if (Number.isInteger(n) && n >= min && n <= max) return n;
    return fallback;
};

const provenSessionTtl = (env = process.env) =>
    boundedInt(env.VAULT_LEGACY_PROVEN_SESSION_TTL_SECONDS, DEFAULT_PROVEN_TTL_SECONDS, 60, LEGACY_SESSION_TTL_SECONDS);

const challengeTtlSeconds = (env = process.env) =>
    boundedInt(env.VAULT_LEGACY_CHALLENGE_TTL_SECONDS, DEFAULT_CHALLENGE_TTL_SECONDS, 30, 15 * 60);

const challengePerMinute = (env = process.env) =>
    boundedInt(env.VAULT_LEGACY_CHALLENGE_PER_IP_PER_MINUTE, DEFAULT_CHALLENGE_PER_MINUTE, 1, 10000);

const sessionPerMinute = (env = process.env) =>
    boundedInt(env.VAULT_LEGACY_SESSION_PER_IP_PER_MINUTE, DEFAULT_SESSION_PER_MINUTE, 1, 10000);

const nowMs = (now) => {
    if (now instanceof Date) return now.getTime();
    if (typeof now === "number" && Number.isFinite(now)) return now;
    return Date.now();
};

const useSharedStore = (env = process.env) => {
    const forced = String(env.VAULT_LEGACY_STATE_STORE || process.env.VAULT_LEGACY_STATE_STORE || "")
        .trim()
        .toLowerCase();
    if (forced === "memory") return false;
    if (forced === "mongo") return true;
    if (process.env.JEST_WORKER_ID) return false;
    return mongoose.connection.readyState === 1;
};

const normalizeIdentifier = (value) => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (trimmed.length < 1 || trimmed.length > IDENTIFIER_MAX) return null;
    if (/[\u0000-\u001F\u007F\s]/.test(trimmed)) return null;
    if (ethers.isAddress(trimmed)) return ethers.getAddress(trimmed);
    return trimmed;
};

const normalizeAddress = (value) => {
    if (typeof value !== "string" || !ethers.isAddress(value.trim())) return null;
    return ethers.getAddress(value.trim());
};

/**
 * Exact EIP-191 message. Clients sign this string; they do not rebuild it.
 * @param {{ identifier: string, address: string, nonce: string, expiresAtUnix: number }} parts
 */
const buildSessionMessage = ({ identifier, address, nonce, expiresAtUnix }) =>
    ["ZelfLegacy session", `identifier: ${identifier}`, `address: ${address}`, `nonce: ${nonce}`, `expires: ${expiresAtUnix}`].join(
        "\n"
    );

const pruneWindows = (now) => {
    if (windows.size < 2000) return;
    for (const [key, bucket] of windows) {
        if (now - bucket.start >= MINUTE_MS) windows.delete(key);
    }
};

const takeWindow = (key, limit, now, code) => {
    pruneWindows(now);
    const bucket = windows.get(key);
    if (!bucket || now - bucket.start >= MINUTE_MS) {
        windows.set(key, { start: now, count: 1 });
        return;
    }
    if (bucket.count >= limit) throw sessionError(code, 429);
    bucket.count += 1;
};

const rateKey = (prefix, ip) => `${prefix}:${String(ip || "").trim() || "missing"}`;

const assertChallengeRate = (ip, env, now) => {
    takeWindow(rateKey("challenge", ip), challengePerMinute(env), now, "CHALLENGE_RATE_LIMITED");
};

const assertSessionRate = (ip, env, now) => {
    takeWindow(rateKey("session", ip), sessionPerMinute(env), now, "SESSION_RATE_LIMITED");
};

const pruneMemoryChallenges = (now) => {
    if (memoryChallenges.size < 1000) return;
    for (const [id, row] of memoryChallenges) {
        if (row.expiresAtMs <= now) memoryChallenges.delete(id);
    }
};

const memoryStore = {
    async put(row) {
        pruneMemoryChallenges(row.createdAtMs || Date.now());
        memoryChallenges.set(row.challengeId, row);
    },
    async get(challengeId) {
        return memoryChallenges.get(challengeId) || null;
    },
    async consume(challengeId, now) {
        const row = memoryChallenges.get(challengeId);
        if (!row || row.consumedAtMs || row.expiresAtMs <= now) return null;
        row.consumedAtMs = now;
        return row;
    },
};

const mongoStore = {
    async put(row) {
        await Challenge.create({
            challengeId: row.challengeId,
            identifier: row.identifier,
            address: row.address,
            nonce: row.nonce,
            message: row.message,
            expiresAt: new Date(row.expiresAtMs),
        });
    },
    async get(challengeId) {
        const doc = await Challenge.findOne({ challengeId }).lean();
        if (!doc) return null;
        return {
            challengeId: doc.challengeId,
            identifier: doc.identifier,
            address: doc.address,
            nonce: doc.nonce,
            message: doc.message,
            expiresAtMs: new Date(doc.expiresAt).getTime(),
            consumedAtMs: doc.consumedAt ? new Date(doc.consumedAt).getTime() : null,
        };
    },
    async consume(challengeId, now) {
        const doc = await Challenge.findOneAndUpdate(
            { challengeId, consumedAt: null, expiresAt: { $gt: new Date(now) } },
            { $set: { consumedAt: new Date(now) } },
            { new: true }
        ).lean();
        if (!doc) return null;
        return {
            challengeId: doc.challengeId,
            identifier: doc.identifier,
            address: doc.address,
            message: doc.message,
            expiresAtMs: new Date(doc.expiresAt).getTime(),
            consumedAtMs: now,
        };
    },
};

const storeFor = (env) => (useSharedStore(env) ? mongoStore : memoryStore);

const readAuthSig = (authSig) => {
    if (!authSig || typeof authSig !== "object") return null;
    const sig = typeof authSig.sig === "string" ? authSig.sig.trim() : "";
    const signedMessage = typeof authSig.signedMessage === "string" ? authSig.signedMessage : "";
    const address = normalizeAddress(authSig.address);
    if (!sig || !signedMessage || !address) return null;
    return { sig, signedMessage, address };
};

const logLegacySession = (identifier) => {
    console.warn(
        JSON.stringify({
            event: "vault_legacy_session_issued",
            proof: "legacy",
            identifierKind: ethers.isAddress(identifier) ? "address" : "installation",
        })
    );
};

const hasProofAttempt = (body) => {
    if (!body || typeof body !== "object") return false;
    if (body.challengeId) return true;
    if (body.authSig) return true;
    return false;
};

const createChallenge = async ({ body, ip, env = process.env, now }) => {
    const clock = nowMs(now);
    const identifier = normalizeIdentifier(body?.identifier);
    if (!identifier) {
        throw sessionError(body?.identifier ? "IDENTIFIER_INVALID" : "IDENTIFIER_REQUIRED", 400);
    }
    const address = normalizeAddress(body?.address);
    if (!address) throw sessionError("SESSION_ADDRESS_REQUIRED", 400);
    if (ethers.isAddress(identifier) && identifier !== address) {
        throw sessionError("SESSION_ADDRESS_MISMATCH", 400);
    }
    assertChallengeRate(ip, env, clock);

    const ttl = challengeTtlSeconds(env);
    const expiresAtMs = clock + ttl * 1000;
    const expiresAtUnix = Math.floor(expiresAtMs / 1000);
    const nonce = crypto.randomBytes(16).toString("hex");
    const challengeId = crypto.randomBytes(16).toString("hex");
    const message = buildSessionMessage({ identifier, address, nonce, expiresAtUnix });

    try {
        await storeFor(env).put({
            challengeId,
            identifier,
            address,
            nonce,
            message,
            expiresAtMs,
            consumedAtMs: null,
            createdAtMs: clock,
        });
    } catch (_error) {
        throw sessionError("CHALLENGE_STORE_UNAVAILABLE", 503);
    }

    return {
        challengeId,
        message,
        expiresAt: new Date(expiresAtMs).toISOString(),
        expiresIn: ttl,
        address,
    };
};

const verifyChallengeSignature = (row, authSig) => {
    if (authSig.signedMessage !== row.message) throw sessionError("SESSION_MESSAGE_MISMATCH", 401);
    if (authSig.address !== row.address) throw sessionError("SESSION_ADDRESS_MISMATCH", 401);

    let recovered;
    try {
        recovered = ethers.verifyMessage(authSig.signedMessage, authSig.sig);
    } catch (_error) {
        throw sessionError("SESSION_SIGNATURE_INVALID", 401);
    }
    if (ethers.getAddress(recovered) !== row.address) throw sessionError("SESSION_SIGNATURE_INVALID", 401);
};

const issueSession = async ({ body, ip, env = process.env, now }) => {
    const clock = nowMs(now);
    const identifier = normalizeIdentifier(body?.identifier);
    if (!identifier) {
        throw sessionError(body?.identifier ? "IDENTIFIER_INVALID" : "IDENTIFIER_REQUIRED", 400);
    }
    assertSessionRate(ip, env, clock);

    if (!hasProofAttempt(body)) {
        if (sessionProofMode(env) === "required") throw sessionError("SESSION_PROOF_REQUIRED", 401);
        logLegacySession(identifier);
        return {
            proof: "legacy",
            expiresIn: LEGACY_SESSION_TTL_SECONDS,
            claims: {
                identifier,
                type: "vault-legacy",
                proof: "legacy",
                iat: Math.floor(clock / 1000),
            },
        };
    }

    const challengeId = typeof body.challengeId === "string" ? body.challengeId.trim() : "";
    const authSig = readAuthSig(body.authSig);
    if (!challengeId || !authSig) throw sessionError("SESSION_PROOF_INCOMPLETE", 400);

    let row;
    try {
        row = await storeFor(env).get(challengeId);
    } catch (_error) {
        throw sessionError("CHALLENGE_STORE_UNAVAILABLE", 503);
    }
    if (!row) throw sessionError("CHALLENGE_NOT_FOUND", 400);
    if (row.identifier !== identifier) throw sessionError("CHALLENGE_IDENTIFIER_MISMATCH", 400);
    if (row.consumedAtMs) throw sessionError("CHALLENGE_CONSUMED", 400);
    if (row.expiresAtMs <= clock) throw sessionError("CHALLENGE_EXPIRED", 400);

    verifyChallengeSignature(row, authSig);

    let consumed;
    try {
        consumed = await storeFor(env).consume(challengeId, clock);
    } catch (_error) {
        throw sessionError("CHALLENGE_STORE_UNAVAILABLE", 503);
    }
    if (!consumed) throw sessionError("CHALLENGE_CONSUMED", 400);

    const expiresIn = provenSessionTtl(env);
    return {
        proof: "eip191",
        expiresIn,
        address: row.address,
        claims: {
            identifier,
            type: "vault-legacy",
            proof: "eip191",
            ethAddress: row.address,
            iat: Math.floor(clock / 1000),
        },
    };
};

const _resetSessionProofState = () => {
    memoryChallenges.clear();
    windows.clear();
};

module.exports = {
    LEGACY_SESSION_TTL_SECONDS,
    DEFAULT_PROVEN_TTL_SECONDS,
    buildSessionMessage,
    createChallenge,
    issueSession,
    normalizeIdentifier,
    sessionProofMode,
    _resetSessionProofState,
};
