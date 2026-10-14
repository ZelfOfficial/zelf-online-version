/**
 * Domain-wide ZelfKeys listing for the license owner / staff (dashboard admin view).
 * Returns pin METADATA ONLY (type, owner, label, folder, protection, dates). It never returns the
 * encrypted QR/proof URL nor any decrypted secret.
 *
 * Data source: Pinata keyvalues. Every ZelfKey pin carries publicData { type, keyOwner: "<name>.<domain>",
 * category: "<keyOwner>_<type>" }. We query by exact `type`, keep pins whose keyOwner belongs to the domain,
 * and cache the per-domain snapshot (SWR) so pagination/search/filters are served from memory.
 */
const { createSwrCache } = require("../../../Core/utils/swr-snapshot-cache");

const KEY_TYPES = ["password", "notes", "credit_card", "contact", "zotp"];
const MAX_PER_TYPE = 20000;
const cache = createSwrCache({ ttlMs: 2 * 60 * 1000, maxStaleMs: 30 * 60 * 1000 });

const labelOf = (pd) => {
    if (pd.alias) return pd.alias;
    if (pd.website) return pd.website;
    if (pd.issuer) return pd.issuer;
    if (pd.title) return pd.title;
    if (pd.name) return pd.name;
    return "";
};

const toItem = (file) => {
    const pd = file.publicData || {};
    return {
        id: file.id || file.cid,
        type: pd.type,
        owner: pd.keyOwner,
        label: labelOf(pd),
        folder: pd.folder || null,
        protection: pd.protection || "face",
        createdAt: file.created_at || file.createdAt || pd.timestamp || null,
        updatedAt: file.updated_at || file.updatedAt || null,
    };
};

const belongsToDomain = (file, type, domain) => {
    const pd = file?.publicData || {};
    const owner = String(pd.keyOwner || "").toLowerCase();
    if (!owner.endsWith(`.${domain}`)) return false;
    if (pd.type !== type) return false;
    return String(pd.category || "").toLowerCase() === `${owner}_${type}`;
};

const loadDomainSnapshot = async (domain, IPFS) => {
    const lists = await Promise.all(
        KEY_TYPES.map(async (type) => {
            const files = await IPFS.filter("type", type, { limit: MAX_PER_TYPE, throwOnError: true });
            return (Array.isArray(files) ? files : []).filter((f) => belongsToDomain(f, type, domain)).map(toItem);
        }),
    );
    const items = lists.flat();
    items.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    return items;
};

/**
 * @param {Object} query { domain?, page=1, pageSize=50, type?, owner?, search? }
 * @param {Object} jwt authenticated user
 */
const listDomainKeys = async (query = {}, jwt, deps = {}) => {
    const IPFS = deps.IPFS || require("../../../Core/ipfs");
    const resolveAuthorizedDomain =
        deps.resolveAuthorizedDomain || require("../../License/modules/license-domain-access.module").resolveAuthorizedDomain;
    const swr = deps.cache || cache;

    const { domain } = await resolveAuthorizedDomain(jwt, query.domain);
    const { value: all, ageMs } = await swr.get(`zelfkeys:${domain}`, () => loadDomainSnapshot(domain, IPFS));

    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize, 10) || 50));
    const type = query.type ? String(query.type) : "";
    const owner = query.owner ? String(query.owner).toLowerCase() : "";
    const search = query.search ? String(query.search).toLowerCase() : "";

    const filtered = all.filter((item) => {
        if (type && item.type !== type) return false;
        if (owner && !String(item.owner || "").toLowerCase().includes(owner)) return false;
        if (search) {
            const hay = `${item.label} ${item.owner} ${item.folder || ""}`.toLowerCase();
            if (!hay.includes(search)) return false;
        }
        return true;
    });

    const counts = KEY_TYPES.reduce((acc, t) => ({ ...acc, [t]: 0 }), {});
    const owners = new Set();
    for (const item of all) {
        counts[item.type] = (counts[item.type] || 0) + 1;
        if (item.owner) owners.add(item.owner);
    }

    return {
        domain,
        page,
        pageSize,
        total: filtered.length,
        totalPages: Math.max(1, Math.ceil(filtered.length / pageSize)),
        domainTotal: all.length,
        countsByType: counts,
        owners: Array.from(owners).sort(),
        items: filtered.slice((page - 1) * pageSize, page * pageSize),
        snapshotAgeSec: Math.round(ageMs / 1000),
    };
};

module.exports = { listDomainKeys, loadDomainSnapshot, belongsToDomain, toItem, KEY_TYPES };
