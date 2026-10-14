/**
 * Domain analytics for the dashboard (license owner / staff).
 *
 * Instead of the dashboard paging through every tag, the API keeps one compact snapshot per domain
 * (name/type/plan/origin/storage/dates) in a stale-while-revalidate cache (fresh 5 min, served stale
 * up to 1 h while refreshing in the background) and answers:
 *   - getSummary: aggregate counts + daily buckets + recent leases (small payload)
 *   - listRecords: filtered, paginated drill-down (page size 50, max 100)
 */
const { createSwrCache } = require("../../../Core/utils/swr-snapshot-cache");

const SNAPSHOT_CAP = 50000;
const DAILY_WINDOW_DAYS = 60;
const RECENT_N = 10;
const ARWEAVE_TIMEOUT_MS = 15000;
const cache = createSwrCache({ ttlMs: 5 * 60 * 1000, maxStaleMs: 60 * 60 * 1000 });

const parseDate = (s) => {
    if (!s) return null;
    const str = String(s);
    const iso = str.includes(" ") && !str.includes("T") ? str.replace(" ", "T") : str;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : t;
};

const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Mirrors the dashboard's normalizeTagRow so numbers match what users saw before. */
const normalizeRow = (raw, storage) => {
    let pd = raw?.publicData ?? raw?.tagObject?.publicData ?? {};
    if (pd?.extraParams && typeof pd.extraParams === "string") {
        try {
            pd = { ...pd, ...JSON.parse(pd.extraParams) };
        } catch {
            /* ignore */
        }
    }
    const name = (typeof raw?.name === "string" && raw.name) || pd.zelfName || pd.avaxName || pd.tagName || "";
    if (!name) return null;
    return {
        name,
        type: String(pd.type || "").toLowerCase(),
        plan: String(pd.plan || "").toLowerCase() || null,
        origin: String(pd.origin || "unknown").toLowerCase(),
        storage,
        registeredAt: pd.registeredAt || raw?.created_at || pd.renewedAt || null,
        expiresAt: pd.expiresAt || null,
    };
};

const withTimeout = (p, ms) =>
    Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms).unref?.())]);

const loadSnapshot = async (domain, deps) => {
    const TagsIPFSModule = deps.TagsIPFSModule || require("../../Tags/modules/tags-ipfs.module");
    const TagsArweaveModule = deps.TagsArweaveModule || require("../../Tags/modules/tags-arweave.module");

    const ipfsRows = await TagsIPFSModule.searchByDomain({ domain, limit: SNAPSHOT_CAP, pageOffset: 0 });
    let arweaveRows = [];
    try {
        arweaveRows = (await withTimeout(TagsArweaveModule.searchByDomain({ domain }), ARWEAVE_TIMEOUT_MS)) || [];
    } catch (e) {
        console.warn("analytics_arweave_skipped", domain, e?.message);
    }

    const seen = new Map();
    for (const [rows, storage] of [
        [ipfsRows || [], "IPFS"],
        [arweaveRows, "Arweave"],
    ]) {
        for (const raw of rows) {
            const r = normalizeRow(raw, storage);
            if (!r) continue;
            const key = r.name.toLowerCase();
            if (!seen.has(key)) seen.set(key, r);
        }
    }
    const records = Array.from(seen.values());
    records.sort((a, b) => (parseDate(b.registeredAt) || 0) - (parseDate(a.registeredAt) || 0));
    return { records, generatedAt: new Date().toISOString() };
};

const isPaid = (r) => r.type === "mainnet";
const isActiveAt = (r, at) => {
    const exp = parseDate(r.expiresAt);
    return exp == null || exp > at;
};
const baseName = (name, domain) => {
    let n = String(name);
    if (n.endsWith(`.${domain}`)) n = n.slice(0, -(domain.length + 1));
    return n;
};
const leaseBucket = (r) => {
    const reg = parseDate(r.registeredAt);
    const exp = parseDate(r.expiresAt);
    if (reg == null || exp == null) return null;
    const years = (exp - reg) / (1000 * 60 * 60 * 24 * 365.25);
    if (years < 0.5) return null;
    if (years < 2) return "1";
    if (years < 3) return "2";
    if (years < 4) return "3";
    if (years < 5) return "4";
    if (years < 100) return "5";
    return "lifetime";
};
const lengthBucket = (len) => (len <= 3 ? "1-3" : len <= 10 ? "4-10" : len <= 20 ? "11-20" : "21-27");
const inc = (obj, k) => {
    obj[k] = (obj[k] || 0) + 1;
};

const buildSummary = (records, domain, nowMs = Date.now(), periodDays = 30) => {
    const todayStart = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate());
    const windowStart = todayStart - (DAILY_WINDOW_DAYS - 1) * 86400000;
    const previousPeriodStart = todayStart - (2 * periodDays - 1) * 86400000;

    const daily = new Map();
    for (let t = windowStart; t <= todayStart; t += 86400000) daily.set(dayKey(t), { date: dayKey(t), all: 0, paid: 0, active: 0 });

    const totals = { total: records.length, paid: 0, active: 0, activePreviousPeriod: 0 };
    const byType = {};
    const byPlan = {};
    const byOrigin = {};
    const byStorage = {};
    const byNameLength = { "1-3": 0, "4-10": 0, "11-20": 0, "21-27": 0 };
    const byLeaseYears = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, lifetime: 0 };

    for (const r of records) {
        const paid = isPaid(r);
        const active = isActiveAt(r, nowMs);
        if (paid) totals.paid++;
        if (active) totals.active++;
        if (isActiveAt(r, previousPeriodStart)) totals.activePreviousPeriod++;
        inc(byType, r.type || "unknown");
        inc(byPlan, r.plan || "unknown");
        inc(byOrigin, r.origin || "unknown");
        inc(byStorage, r.storage);
        byNameLength[lengthBucket(baseName(r.name, domain).length)]++;
        const lb = leaseBucket(r);
        if (lb) byLeaseYears[lb]++;

        const reg = parseDate(r.registeredAt);
        if (reg != null && reg >= windowStart && reg < todayStart + 86400000) {
            const d = daily.get(dayKey(reg));
            if (d) {
                d.all++;
                if (paid) d.paid++;
                if (active) d.active++;
            }
        }
    }

    return {
        domain,
        periodDays,
        totals,
        byType,
        byPlan,
        byOrigin,
        byStorage,
        byNameLength,
        byLeaseYears,
        daily: Array.from(daily.values()),
        recent: records.slice(0, RECENT_N),
    };
};

const _snapshotFor = async (query, jwt, deps) => {
    const resolveAuthorizedDomain =
        deps.resolveAuthorizedDomain || require("../../License/modules/license-domain-access.module").resolveAuthorizedDomain;
    const swr = deps.cache || cache;
    const { domain } = await resolveAuthorizedDomain(jwt, query.domain);
    const { value, ageMs, stale } = await swr.get(`analytics:${domain}`, () => loadSnapshot(domain, deps));
    return { domain, snapshot: value, ageMs, stale };
};

const getSummary = async (query = {}, jwt, deps = {}) => {
    const { domain, snapshot, ageMs, stale } = await _snapshotFor(query, jwt, deps);
    return {
        ...buildSummary(snapshot.records, domain, deps.now ? deps.now() : Date.now()),
        generatedAt: snapshot.generatedAt,
        snapshotAgeSec: Math.round(ageMs / 1000),
        stale,
    };
};

const listRecords = async (query = {}, jwt, deps = {}) => {
    const { domain, snapshot } = await _snapshotFor(query, jwt, deps);
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize, 10) || 50));
    const from = parseDate(query.from);
    const to = parseDate(query.to);
    const search = String(query.search || "").toLowerCase();
    const nowMs = deps.now ? deps.now() : Date.now();

    const rows = snapshot.records.filter((r) => {
        if (query.type && r.type !== String(query.type).toLowerCase()) return false;
        if (query.plan && (r.plan || "unknown") !== String(query.plan).toLowerCase()) return false;
        if (query.origin && r.origin !== String(query.origin).toLowerCase()) return false;
        if (query.storage && r.storage.toLowerCase() !== String(query.storage).toLowerCase()) return false;
        if (query.status === "active" && !isActiveAt(r, nowMs)) return false;
        if (query.status === "expired" && isActiveAt(r, nowMs)) return false;
        if (from != null || to != null) {
            const reg = parseDate(r.registeredAt);
            if (reg == null) return false;
            if (from != null && reg < from) return false;
            if (to != null && reg > to) return false;
        }
        if (search && !r.name.toLowerCase().includes(search)) return false;
        return true;
    });

    return {
        domain,
        page,
        pageSize,
        total: rows.length,
        totalPages: Math.max(1, Math.ceil(rows.length / pageSize)),
        items: rows.slice((page - 1) * pageSize, page * pageSize),
        generatedAt: snapshot.generatedAt,
    };
};

module.exports = { getSummary, listRecords, buildSummary, normalizeRow, loadSnapshot };
