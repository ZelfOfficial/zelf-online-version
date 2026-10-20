const crypto = require("crypto");
const config = require("../../../Core/config");
const FacePowUsed = require("../models/face-pow-used.model");
const FacePowChallenge = require("../models/face-pow-challenge.model");

const ALGORITHM = "SHA-256";
/** Clients must match: count leading zero bits in SHA-256(salt + solution) hex digest. */
const DIFFICULTY_MODE = "leading_zero_bits";

const getSecret = () => {
    const secret = config.faceSecurity?.pow?.hmacSecret;
    if (!secret || typeof secret !== "string" || secret.length < 16) {
        return null;
    }
    return secret;
};

const difficultyForFailures = (failureCount) => {
    const base = config.faceSecurity?.pow?.baseDifficulty || 16;
    const max = config.faceSecurity?.pow?.maxDifficulty || 19;
    const extra = Math.max(0, Math.floor((failureCount || 0) / 2));
    return Math.min(max, base + extra);
};

const signPayload = (parts) => {
    const secret = getSecret();
    if (!secret) {
        const error = new Error("503:face_pow_unconfigured");
        error.status = 503;
        error.clientCode = "face_pow_unconfigured";
        throw error;
    }
    const message = parts.join("|");
    return crypto.createHmac("sha256", secret).update(message).digest("hex");
};

/**
 * @param {{ action: string, identifier: string, failureCount?: number }} params
 */
const issueChallenge = async ({ action, identifier, failureCount = 0 }) => {
    const ttlSec = config.faceSecurity?.pow?.challengeTtlSec || 300;
    const challengeId = crypto.randomBytes(16).toString("hex");
    const salt = crypto.randomBytes(16).toString("hex");
    const difficulty = difficultyForFailures(failureCount);
    const expiresAt = new Date(Date.now() + ttlSec * 1000);
    const expiresAtIso = expiresAt.toISOString();
    const signature = signPayload([challengeId, salt, String(difficulty), expiresAtIso, identifier, action]);

    await FacePowChallenge.create({
        challengeId,
        salt,
        difficulty,
        expiresAt,
        signature,
        identifier,
        action,
    });

    return {
        challengeId,
        algorithm: ALGORITHM,
        difficultyMode: DIFFICULTY_MODE,
        salt,
        difficulty,
        expiresAt: expiresAtIso,
        signature,
    };
};

const leadingZeroBits = (hashHex) => {
    const hash = Buffer.from(hashHex, "hex");
    let bits = 0;
    for (const byte of hash) {
        if (byte === 0) {
            bits += 8;
            continue;
        }
        for (let j = 7; j >= 0; j--) {
            if (byte & (1 << j)) {
                return bits + (7 - j);
            }
        }
        return bits;
    }
    return bits;
};

const hashMeetsDifficulty = (hashHex, difficulty) => {
    const required = Math.max(0, Number(difficulty) || 0);
    return leadingZeroBits(hashHex) >= required;
};

/**
 * @param {{ challengeId: string, salt: string, difficulty: number, expiresAt: string, signature: string, identifier: string, action: string, solution: string|number }} params
 */
const verifySolution = async (params) => {
    let {
        challengeId,
        salt,
        difficulty,
        expiresAt,
        signature,
        identifier,
        action,
        solution,
    } = params;

    if (!challengeId || solution === undefined || solution === null) {
        return { ok: false, code: "face_pow_invalid" };
    }

    if (!salt || !signature) {
        const stored = await FacePowChallenge.findOne({ challengeId }).lean();
        if (!stored) {
            return { ok: false, code: "face_pow_invalid" };
        }
        salt = stored.salt;
        difficulty = stored.difficulty;
        expiresAt =
            stored.expiresAt instanceof Date ? stored.expiresAt.toISOString() : String(stored.expiresAt);
        signature = stored.signature;
        identifier = stored.identifier;
        action = stored.action;
    }

    const expiresAtIso =
        expiresAt instanceof Date ? expiresAt.toISOString() : String(expiresAt);

    if (identifier && params.identifier && params.identifier !== identifier) {
        return { ok: false, code: "face_pow_invalid" };
    }
    if (action && params.action && params.action !== action) {
        return { ok: false, code: "face_pow_invalid" };
    }

    const expectedSig = signPayload([challengeId, salt, String(difficulty), expiresAtIso, identifier, action]);
    if (expectedSig !== signature) {
        return { ok: false, code: "face_pow_invalid" };
    }

    const expiry = new Date(expiresAtIso);
    if (!Number.isFinite(expiry.getTime()) || expiry.getTime() < Date.now()) {
        return { ok: false, code: "face_pow_invalid" };
    }

    const hash = crypto.createHash("sha256").update(`${salt}${solution}`).digest("hex");
    if (!hashMeetsDifficulty(hash, Number(difficulty) || 1)) {
        return { ok: false, code: "face_pow_invalid" };
    }

    const ttlMs = Math.max(60000, (config.faceSecurity?.pow?.challengeTtlSec || 300) * 1000);
    try {
        await FacePowUsed.create({
            challengeId,
            expiresAt: new Date(Date.now() + ttlMs),
        });
    } catch (err) {
        if (err?.code === 11000) {
            return { ok: false, code: "face_pow_invalid" };
        }
        throw err;
    }

    await FacePowChallenge.deleteOne({ challengeId }).catch(() => {});

    return { ok: true };
};

module.exports = {
    ALGORITHM,
    DIFFICULTY_MODE,
    issueChallenge,
    verifySolution,
    difficultyForFailures,
    hashMeetsDifficulty,
    leadingZeroBits,
};
