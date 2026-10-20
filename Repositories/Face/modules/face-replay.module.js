const crypto = require("crypto");
const config = require("../../../Core/config");
const FaceReplayDigest = require("../models/face-replay-digest.model");

const retentionMs = () => (config.faceSecurity?.replay?.retentionDays || 7) * 24 * 60 * 60 * 1000;

const normalizeFaceForDigest = (faceBase64) => {
    if (faceBase64 == null) return "";
    const trimmed = String(faceBase64).trim();
    const marker = "base64,";
    const idx = trimmed.indexOf(marker);
    const raw = idx !== -1 && trimmed.slice(0, 5).toLowerCase() === "data:" ? trimmed.slice(idx + marker.length) : trimmed;
    return raw.replace(/\s+/g, "");
};

const digestFace = (faceBase64) =>
    crypto.createHash("sha256").update(normalizeFaceForDigest(faceBase64)).digest("hex");

const checkNotReplay = async ({ faceBase64, identifier, action }) => {
    if (!config.faceSecurity?.replay?.enabled) return;

    const digest = digestFace(faceBase64);
    const existing = await FaceReplayDigest.findOne({ digest, identifier, action }).lean();
    if (existing) {
        const error = new Error("409:face_replay_detected");
        error.status = 409;
        error.clientCode = "face_replay_detected";
        error.clientMessage =
            "This face capture was already used for this action. Take a new photo, request a fresh nonce from POST /api/face/nonce, and try again.";
        throw error;
    }
};

const recordReplay = async ({ faceBase64, identifier, action }) => {
    if (!config.faceSecurity?.replay?.enabled) return;

    const digest = digestFace(faceBase64);
    const expiresAt = new Date(Date.now() + retentionMs());

    try {
        await FaceReplayDigest.create({ digest, identifier, action, expiresAt });
    } catch (err) {
        if (err?.code === 11000) {
            return;
        }
        throw err;
    }
};

module.exports = {
    digestFace,
    checkNotReplay,
    recordReplay,
    normalizeFaceForDigest,
};
