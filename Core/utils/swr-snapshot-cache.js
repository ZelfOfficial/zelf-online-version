/**
 * Small stale-while-revalidate cache for expensive per-key snapshots (e.g. "all tags of a domain").
 * - fresh for `ttlMs`: served from memory
 * - stale (older than ttl, younger than maxStaleMs): served immediately, refreshed in the background
 * - missing/expired: loaded once (concurrent callers share the same in-flight promise)
 */
const createSwrCache = ({ ttlMs = 5 * 60 * 1000, maxStaleMs = 60 * 60 * 1000, now = () => Date.now() } = {}) => {
    const entries = new Map();

    const _refresh = (key, loader) => {
        const entry = entries.get(key) || {};
        if (entry.inflight) return entry.inflight;
        const inflight = Promise.resolve()
            .then(loader)
            .then((value) => {
                entries.set(key, { value, at: now(), inflight: null });
                return value;
            })
            .catch((error) => {
                const cur = entries.get(key);
                if (cur) cur.inflight = null;
                throw error;
            });
        entries.set(key, { ...entry, inflight });
        return inflight;
    };

    const get = async (key, loader) => {
        const entry = entries.get(key);
        const age = entry && entry.at ? now() - entry.at : Infinity;
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

module.exports = { createSwrCache };
