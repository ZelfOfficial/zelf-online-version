const crypto = require("crypto");
const config = require("../../../Core/config");
const FaceNonce = require("../models/face-nonce.model");

const ttlMs = () => (config.faceSecurity?.nonce?.ttlSec || 90) * 1000;

/**
 * @param {{ action: string, identifier: string, sessionKey: string }} params
 */
const createNonce = async ({ action, identifier, sessionKey }) => {
    const nonce = crypto.randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + ttlMs());

    await FaceNonce.create({
        nonce,
        action,
        identifier,
        sessionKey,
        expiresAt,
    });

    return {
        nonce,
        expiresAt: expiresAt.toISOString(),
    };
};

/**
 * Atomically mark nonce used when it matches action, identifier, and session.
 * @returns {{ ok: boolean, code?: string }}
 */
const consumeNonce = async ({ nonce, action, identifier, sessionKey }) => {
    if (!nonce) {
        return { ok: false, code: "face_nonce_missing", missing: true };
    }

    const row = await FaceNonce.findOneAndUpdate(
        {
            nonce,
            action,
            identifier,
            sessionKey,
            usedAt: null,
            expiresAt: { $gt: new Date() },
        },
        { $set: { usedAt: new Date() } },
        { new: true }
    ).lean();

    if (!row) {
        const existing = await FaceNonce.findOne({ nonce }).lean();
        if (existing?.usedAt) {
            return { ok: false, code: "face_nonce_used" };
        }
        if (existing && (existing.action !== action || existing.identifier !== identifier)) {
            return { ok: false, code: "face_nonce_mismatch" };
        }
        return { ok: false, code: "face_nonce_invalid", missing: false };
    }

    return { ok: true };
};

module.exports = {
    createNonce,
    consumeNonce,
};
