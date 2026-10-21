const KEEP_PRIOR_SNAPSHOT = Symbol("KEEP_PRIOR_SNAPSHOT");

const keepPriorSnapshotSignal = () => {
	const error = new Error("swr_keep_prior_snapshot");
	error[KEEP_PRIOR_SNAPSHOT] = true;
	return error;
};

const isKeepPriorSnapshotSignal = (error) => Boolean(error && error[KEEP_PRIOR_SNAPSHOT]);

/**
 * Small stale-while-revalidate cache for expensive per-key snapshots (e.g. "all tags of a domain").
 * - fresh for `ttlMs`: served from memory
 * - stale (older than ttl, younger than maxStaleMs): served immediately, refreshed in the background
 * - missing/expired: loaded once (concurrent callers share the same in-flight promise)
 */
const createSwrCache = ({
    ttlMs = 5 * 60 * 1000,
    maxStaleMs = 60 * 60 * 1000,
    now = () => Date.now(),
    warmIntervalMs = 0, // >0: refresh recently used keys in the background so readers never wait for a cold load
    warmIdleMs = 24 * 60 * 60 * 1000, // stop warming keys nobody asked for in this long
    shouldPersist = () => true,
} = {}) => {
    const entries = new Map();
    const loaders = new Map(); // key -> { loader, lastAccess }
    let timer = null;

    const _startWarmer = () => {
        if (!warmIntervalMs || timer) return;
        timer = setInterval(() => {
            for (const [key, info] of loaders) {
                if (now() - info.lastAccess > warmIdleMs) {
                    loaders.delete(key);
                    continue;
                }
                _refresh(key, info.loader).catch((e) => console.error("swr_warm_failed", key, e?.message));
            }
        }, warmIntervalMs);
        if (typeof timer.unref === "function") timer.unref();
    };

    const _refresh = (key, loader) => {
        const entry = entries.get(key) || {};
        if (entry.inflight) return entry.inflight;
        const inflight = Promise.resolve()
            .then(loader)
            .then((value) => {
                const cur = entries.get(key) || {};
                if (!shouldPersist(value)) {
                    entries.set(key, { ...cur, inflight: null });
                    return value;
                }
                entries.set(key, { value, at: now(), inflight: null });
                return value;
            })
            .catch((error) => {
                const cur = entries.get(key) || {};
                if (isKeepPriorSnapshotSignal(error)) {
                    entries.set(key, { ...cur, inflight: null });
                    if (cur.value !== undefined) return cur.value;
                }
                if (cur) cur.inflight = null;
                throw error;
            });
        entries.set(key, { ...entry, inflight });
        return inflight;
    };

    const get = async (key, loader) => {
        if (warmIntervalMs) {
            loaders.set(key, { loader, lastAccess: now() });
            _startWarmer();
        }
        const entry = entries.get(key);
        const age = entry && entry.at != null ? now() - entry.at : Infinity;
        if (entry && "value" in entry && age < ttlMs) return { value: entry.value, ageMs: age, stale: false };
        if (entry && "value" in entry && age < maxStaleMs) {
            _refresh(key, loader).catch((e) => console.error("swr_refresh_failed", key, e?.message));
            return { value: entry.value, ageMs: age, stale: true };
        }
        const value = await _refresh(key, loader);
        return { value, ageMs: 0, stale: false };
    };

    return { get, clear: () => entries.clear(), _entries: entries };
};

module.exports = { createSwrCache, keepPriorSnapshotSignal, isKeepPriorSnapshotSignal };
