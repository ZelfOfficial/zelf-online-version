const crypto = require("crypto");
const config = require("../../../Core/config");
const FacePowUsed = require("../models/face-pow-used.model");
const FacePowChallenge = require("../models/face-pow-challenge.model");

const ALGORITHM = "SHA-256";

const getSecret = () => {
    const secret = config.faceSecurity?.pow?.hmacSecret;
    if (!secret || typeof secret !== "string" || secret.length < 16) {
        return null;
    }
    return secret;
};

const difficultyForFailures = (failureCount) => {
    const base = config.faceSecurity?.pow?.baseDifficulty || 4;
    const max = config.faceSecurity?.pow?.maxDifficulty || 8;
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
        salt,
        difficulty,
        expiresAt: expiresAtIso,
        signature,
    };
};

const hashMeetsDifficulty = (hashHex, difficulty) => {
    const prefix = "0".repeat(Math.max(0, difficulty));
    return hashHex.startsWith(prefix);
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
    issueChallenge,
    verifySolution,
    difficultyForFailures,
    hashMeetsDifficulty,
};
