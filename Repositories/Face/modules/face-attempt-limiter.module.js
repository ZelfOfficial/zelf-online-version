const config = require("../../../Core/config");
const FaceAttemptState = require("../models/face-attempt-state.model");

const cfg = () => config.faceSecurity?.attemptLimiter || {};

const lockoutLevelDecayMs = () => (cfg().lockoutLevelDecaySec || 86400) * 1000;

/**
 * Mongo TTL must cover active lock + escalation decay (not just 2× failure window).
 * @param {{ windowStartedAt?: Date, lockedUntil?: Date|null }} row
 */
const computeStateExpiresAt = (row, now = new Date()) => {
    const windowMs = (cfg().identityWindowSec || 900) * 1000;
    const windowStart = row.windowStartedAt ? new Date(row.windowStartedAt).getTime() : now.getTime();
    const windowEnd = windowStart + windowMs;
    const lockEnd = row.lockedUntil ? new Date(row.lockedUntil).getTime() : 0;
    const anchor = Math.max(windowEnd, lockEnd, now.getTime());
    const withLockDecay = lockEnd > 0 ? lockEnd + lockoutLevelDecayMs() : anchor;
    return new Date(Math.max(anchor, withLockDecay));
};

const normalizeIp = (ip) => {
    if (ip == null || ip === "") return null;
    const s = String(ip).trim();
    return s.length ? s : null;
};

const deviceScopeKey = (deviceKey, identityKey) => {
    if (!deviceKey) return null;
    if (identityKey) return `${deviceKey}::${identityKey}`;
    return deviceKey;
};

const getOrCreateState = async (scope, key) => {
    const now = new Date();
    const windowSec = cfg().identityWindowSec || 900;
    const windowMs = windowSec * 1000;

    let row = await FaceAttemptState.findOne({ scope, key }).lean();
    if (!row) {
        try {
            row = await FaceAttemptState.create({
                scope,
                key,
                failureCount: 0,
                windowStartedAt: now,
                lockedUntil: null,
                lockoutLevel: 0,
                expiresAt: computeStateExpiresAt({ windowStartedAt: now, lockedUntil: null }, now),
            });
            return row.toObject();
        } catch (error) {
            const duplicate = error?.code === 11000 || error?.cause?.code === 11000 || /duplicate key/i.test(`${error?.message || ""} ${error?.cause?.message || ""}`);
            if (!duplicate) throw error;
            row = await FaceAttemptState.findOne({ scope, key }).lean();
            if (row) return row;
            throw error;
        }
    }

    if (row.windowStartedAt && now - new Date(row.windowStartedAt) > windowMs) {
        const lockStillActive =
            row.lockedUntil && new Date(row.lockedUntil).getTime() > now.getTime();
        const $set = {
            failureCount: 0,
            windowStartedAt: now,
            expiresAt: computeStateExpiresAt(
                {
                    windowStartedAt: now,
                    lockedUntil: lockStillActive ? row.lockedUntil : null,
                },
                now
            ),
        };
        if (!lockStillActive) {
            $set.lockedUntil = null;
        }
        const updated = await FaceAttemptState.findOneAndUpdate(
            { scope, key },
            { $set },
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
    if (!cfg().enabled || !key) return { locked: false, failureCount: 0 };

    const row = await getOrCreateState(scope, key);
    if (row.lockedUntil && new Date(row.lockedUntil).getTime() > Date.now()) {
        const retryAfter = Math.max(1, Math.ceil((new Date(row.lockedUntil).getTime() - Date.now()) / 1000));
        return { locked: true, retryAfter, failureCount: row.failureCount || 0 };
    }
    return { locked: false, failureCount: row.failureCount || 0 };
};

const scopeMaxFailures = (scope) => {
    if (scope === "identity") return cfg().identityMaxFailures || 5;
    if (scope === "target") return cfg().targetMaxFailures || 5;
    if (scope === "ip") return cfg().ipMaxFailuresPerHour || 1000;
    return cfg().deviceMaxFailures || 10;
};

const lockoutCodeForScope = (scope) => (scope === "target" || scope === "ip" ? "TOO_MANY_ATTEMPTS" : "face_locked");

/**
 * Identity and device scopes keep the session lockout.
 * Target-name and IP scopes add a shared counter and return TOO_MANY_ATTEMPTS.
 * @param {{ identityKey?: string, targetKey?: string, ip?: string, deviceKey?: string }} keys
 */
const assertFaceAttemptAllowed = async ({ identityKey, targetKey, ip, deviceKey }) => {
    if (!cfg().enabled) {
        return { failureCount: 0, powRequired: false };
    }

    const devKey = deviceScopeKey(deviceKey, identityKey);
    const checks = [];
    if (identityKey) {
        checks.push({ scope: "identity", ...(await assertNotLocked("identity", identityKey)) });
    }
    if (devKey) {
        checks.push({ scope: "device", ...(await assertNotLocked("device", devKey)) });
    }
    if (targetKey) {
        checks.push({ scope: "target", ...(await assertNotLocked("target", targetKey)) });
    }

    if (cfg().ipLockoutEnabled) {
        const normalizedIp = normalizeIp(ip);
        if (normalizedIp) {
            checks.push({ scope: "ip", ...(await assertNotLocked("ip", normalizedIp)) });
        }
    }

    for (const c of checks) {
        if (c.locked) {
            const code = lockoutCodeForScope(c.scope);
            const error = new Error(`429:${code}`);
            error.status = 429;
            error.clientCode = code;
            error.retryAfterSeconds = c.retryAfter;
            throw error;
        }
    }

    const identityCheck = checks.find((c) => c.scope === "identity");
    const identityFailures = identityCheck ? identityCheck.failureCount || 0 : 0;
    const powAfter = cfg().powAfterFailures || 2;
    return {
        failureCount: identityFailures,
        powRequired: identityFailures >= powAfter,
    };
};

const incrementFailures = async (scope, key) => {
    if (!cfg().enabled || !key) return;

    const now = new Date();
    const row = await getOrCreateState(scope, key);
    const nextCount = (row.failureCount || 0) + 1;

    let lockedUntil = row.lockedUntil;
    let lockoutLevel = row.lockoutLevel || 0;

    const maxByScope = scopeMaxFailures(scope);

    if (nextCount >= maxByScope) {
        const durationSec = lockoutDurationSec(lockoutLevel || 0);
        lockedUntil = new Date(now.getTime() + durationSec * 1000);
        const maxLevel = (cfg().lockoutStepsSec || []).length - 1;
        lockoutLevel = Math.min((lockoutLevel || 0) + 1, maxLevel);
    }

    await FaceAttemptState.updateOne(
        { scope, key },
        {
            $set: {
                failureCount: nextCount,
                windowStartedAt: row.windowStartedAt || now,
                lockedUntil,
                lockoutLevel,
                expiresAt: computeStateExpiresAt(
                    {
                        windowStartedAt: row.windowStartedAt || now,
                        lockedUntil,
                    },
                    now
                ),
            },
        }
    );
};

const recordFailedAttempt = async ({ identityKey, targetKey, ip, deviceKey }) => {
    if (!cfg().enabled) return;
    if (identityKey) await incrementFailures("identity", identityKey);
    const devKey = deviceScopeKey(deviceKey, identityKey);
    if (devKey) await incrementFailures("device", devKey);
    if (targetKey) await incrementFailures("target", targetKey);
    if (cfg().ipLockoutEnabled) {
        const normalizedIp = normalizeIp(ip);
        if (normalizedIp) await incrementFailures("ip", normalizedIp);
    }
};

const recordSuccessfulAttempt = async ({ identityKey, targetKey, deviceKey }) => {
    if (!cfg().enabled) return;
    const now = new Date();
    const reset = {
        failureCount: 0,
        windowStartedAt: now,
        lockedUntil: null,
        lockoutLevel: 0,
        expiresAt: computeStateExpiresAt(
            { windowStartedAt: now, lockedUntil: null },
            now
        ),
    };
    if (identityKey) {
        await FaceAttemptState.updateOne({ scope: "identity", key: identityKey }, { $set: reset });
    }
    const devKey = deviceScopeKey(deviceKey, identityKey);
    if (devKey) {
        await FaceAttemptState.updateOne({ scope: "device", key: devKey }, { $set: reset });
    }
    if (targetKey) {
        await FaceAttemptState.updateOne({ scope: "target", key: targetKey }, { $set: reset });
    }
};

module.exports = {
    assertFaceAttemptAllowed,
    recordFailedAttempt,
    recordSuccessfulAttempt,
    deviceScopeKey,
    computeStateExpiresAt,
};
