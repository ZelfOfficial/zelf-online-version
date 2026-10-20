const config = require("../../../Core/config");
const FaceAttemptState = require("../models/face-attempt-state.model");

const cfg = () => config.faceSecurity?.attemptLimiter || {};

const stateTtlMs = () => Math.max((cfg().identityWindowSec || 900) * 2 * 1000, 3600000);

const normalizeIp = (ip) => {
    if (ip == null || ip === "") return null;
    const s = String(ip).trim();
    return s.length ? s : null;
};

const scopeKey = (scope, key) => `${scope}:${key}`;

const getOrCreateState = async (scope, key) => {
    const now = new Date();
    const windowSec = cfg().identityWindowSec || 900;
    const windowMs = windowSec * 1000;

    let row = await FaceAttemptState.findOne({ scope, key }).lean();
    if (!row) {
        row = await FaceAttemptState.create({
            scope,
            key,
            failureCount: 0,
            windowStartedAt: now,
            lockedUntil: null,
            lockoutLevel: 0,
            expiresAt: new Date(now.getTime() + stateTtlMs()),
        });
        return row.toObject();
    }

    if (row.windowStartedAt && now - new Date(row.windowStartedAt) > windowMs) {
        const updated = await FaceAttemptState.findOneAndUpdate(
            { scope, key },
            {
                $set: {
                    failureCount: 0,
                    windowStartedAt: now,
                    lockedUntil: null,
                    lockoutLevel: 0,
                    expiresAt: new Date(now.getTime() + stateTtlMs()),
                },
            },
            { new: true }
        ).lean();
        return updated;
    }

    return row;
};

const lockoutDurationSec = (level) => {
    const steps = cfg().lockoutStepsSec || [900, 3600, 86400];
    const idx = Math.min(Math.max(level, 0), steps.length - 1);
    return steps[idx];
};

const assertNotLocked = async (scope, key) => {
    if (!cfg().enabled) return { locked: false, failureCount: 0 };

    const row = await getOrCreateState(scope, key);
    if (row.lockedUntil && new Date(row.lockedUntil).getTime() > Date.now()) {
        const retryAfter = Math.max(1, Math.ceil((new Date(row.lockedUntil).getTime() - Date.now()) / 1000));
        return { locked: true, retryAfter, failureCount: row.failureCount || 0 };
    }
    return { locked: false, failureCount: row.failureCount || 0 };
};

/**
 * @param {{ identityKey: string, ip?: string, deviceKey?: string }} keys
 */
const assertFaceAttemptAllowed = async ({ identityKey, ip, deviceKey }) => {
    if (!cfg().enabled) {
        return { failureCount: 0, powRequired: false };
    }

    const checks = [
        await assertNotLocked("identity", identityKey),
        ip ? await assertNotLocked("ip", normalizeIp(ip)) : { locked: false, failureCount: 0 },
        deviceKey ? await assertNotLocked("device", deviceKey) : { locked: false, failureCount: 0 },
    ];

    for (const c of checks) {
        if (c.locked) {
            const error = new Error("429:face_locked");
            error.status = 429;
            error.clientCode = "face_locked";
            error.retryAfterSeconds = c.retryAfter;
            throw error;
        }
    }

    const identityFailures = checks[0].failureCount || 0;
    const powAfter = cfg().powAfterFailures || 2;
    return {
        failureCount: identityFailures,
        powRequired: identityFailures >= powAfter,
    };
};

const incrementFailures = async (scope, key) => {
    if (!cfg().enabled) return;

    const now = new Date();
    const row = await getOrCreateState(scope, key);
    const nextCount = (row.failureCount || 0) + 1;

    let lockedUntil = row.lockedUntil;
    let lockoutLevel = row.lockoutLevel || 0;

    const maxByScope =
        scope === "identity"
            ? cfg().identityMaxFailures || 5
            : scope === "ip"
              ? cfg().ipMaxFailuresPerHour || 20
              : cfg().deviceMaxFailures || 10;

    if (nextCount >= maxByScope) {
        lockoutLevel = Math.min((lockoutLevel || 0) + 1, (cfg().lockoutStepsSec || []).length - 1);
        const durationSec = lockoutDurationSec(lockoutLevel);
        lockedUntil = new Date(now.getTime() + durationSec * 1000);
    }

    await FaceAttemptState.updateOne(
        { scope, key },
        {
            $set: {
                failureCount: nextCount,
                windowStartedAt: row.windowStartedAt || now,
                lockedUntil,
                lockoutLevel,
                expiresAt: new Date(now.getTime() + stateTtlMs()),
            },
        }
    );
};

const recordFailedAttempt = async ({ identityKey, ip, deviceKey }) => {
    if (!cfg().enabled) return;
    await incrementFailures("identity", identityKey);
    const normalizedIp = normalizeIp(ip);
    if (normalizedIp) await incrementFailures("ip", normalizedIp);
    if (deviceKey) await incrementFailures("device", deviceKey);
};

const recordSuccessfulAttempt = async ({ identityKey, ip, deviceKey }) => {
    if (!cfg().enabled) return;
    const now = new Date();
    const reset = {
        failureCount: 0,
        windowStartedAt: now,
        lockedUntil: null,
        lockoutLevel: 0,
        expiresAt: new Date(now.getTime() + stateTtlMs()),
    };
    await FaceAttemptState.updateOne({ scope: "identity", key: identityKey }, { $set: reset });
    const normalizedIp = normalizeIp(ip);
    if (normalizedIp) await FaceAttemptState.updateOne({ scope: "ip", key: normalizedIp }, { $set: reset });
    if (deviceKey) await FaceAttemptState.updateOne({ scope: "device", key: deviceKey }, { $set: reset });
};

module.exports = {
    assertFaceAttemptAllowed,
    recordFailedAttempt,
    recordSuccessfulAttempt,
    scopeKey,
};
