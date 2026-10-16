/**
 * zAI read-only tools. Every tool is scoped server-side to ctx.state.zai (the verified zAI token).
 * The model never chooses whose data is read: identity arguments (zelfName, tagName, domain, zid, id,
 * owner, user, account, and address for account tools) are stripped and reported as ignoredArgs.
 * Results are passed through the redaction filter before they reach the model.
 * Cards are built here from tool results only, never from model text.
 */
const axios = require("axios");
const { redactDeep } = require("./zai-redaction.module");

const MAX_TOOL_CALLS_PER_TURN = 5;
const SUPPORTED_CHAINS = ["eth", "sol", "btc"];
const CHAIN_ALIASES = { ethereum: "eth", eth: "eth", solana: "sol", sol: "sol", bitcoin: "btc", btc: "btc" };
const EXPLORERS = {
    eth: (h) => `https://etherscan.io/tx/${h}`,
    sol: (h) => `https://solscan.io/tx/${h}`,
    btc: (h) => `https://mempool.space/tx/${h}`,
};
const DOCS_REPO = "Open-Verifik/zelf-documentation";
const PUBLIC_CODE_REPOS = (process.env.ZAI_PUBLIC_CODE_REPOS || "ZelfOfficial/zelf-extension,Open-Verifik/zelf-documentation")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/* ------------------------------------------------------------------ tool definitions (OpenAI format) */
const fn = (name, description, properties = {}, required = []) => ({
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
});
const chainProp = { type: "string", enum: SUPPORTED_CHAINS, description: "Optional chain filter" };

const definitions = [
    fn("get_account", "The signed-in user's own Zelf ID: name, plan, term, expiry and public addresses. Takes no arguments; the account comes from the verified session."),
    fn("get_balances", "The signed-in user's own balances. Optional chain filter.", { chain: chainProp }),
    fn("get_transactions", "The signed-in user's own recent transactions.", {
        chain: chainProp,
        limit: { type: "integer", minimum: 1, maximum: 20 },
        cursor: { type: "string" },
    }),
    fn(
        "get_transaction",
        "One transaction by hash. Only answers if it involves one of the signed-in user's addresses.",
        { hash: { type: "string" }, chain: { type: "string", enum: SUPPORTED_CHAINS } },
        ["hash", "chain"]
    ),
    fn("get_referrals", "The signed-in user's own referrals. Takes no arguments."),
    fn("get_pricing", "Zelf plans and prices, from the official license JSON on IPFS only. Takes no arguments."),
    fn("search_docs", "Search Zelf documentation (docs.zelf.world).", { query: { type: "string" }, k: { type: "integer", minimum: 1, maximum: 5 } }, ["query"]),
    fn("search_code", "Search Zelf's public open-source repositories.", { query: { type: "string" }, k: { type: "integer", minimum: 1, maximum: 5 } }, ["query"]),
    fn(
        "search_contracts",
        "Look up a public smart contract by address (or name query) on a chain.",
        { query: { type: "string" }, address: { type: "string" }, chain: { type: "string", enum: ["eth"] } },
        ["chain"]
    ),
];
const TOOL_NAMES = new Set(definitions.map((d) => d.function.name));

/* ------------------------------------------------------------------ argument scoping */
const ALLOWED_ARGS = {
    get_account: [],
    get_balances: ["chain"],
    get_transactions: ["chain", "limit", "cursor"],
    get_transaction: ["hash", "chain"],
    get_referrals: [],
    get_pricing: [],
    search_docs: ["query", "k"],
    search_code: ["query", "k"],
    search_contracts: ["query", "address", "chain"],
};

const parseArgs = (raw) => {
    if (raw && typeof raw === "object") return raw;
    try {
        const v = JSON.parse(raw || "{}");
        return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch (_) {
        return {};
    }
};

/** Keep only whitelisted args; everything else (incl. any identity) is dropped and reported. */
const scopeArgs = (name, raw) => {
    const args = parseArgs(raw);
    const allowed = ALLOWED_ARGS[name] || [];
    const clean = {};
    const ignoredArgs = [];
    for (const [k, v] of Object.entries(args)) {
        if (allowed.includes(k) && (typeof v === "string" || typeof v === "number")) clean[k] = v;
        else ignoredArgs.push(k);
    }
    if (clean.chain !== undefined) {
        const c = CHAIN_ALIASES[String(clean.chain).toLowerCase()];
        if (c) clean.chain = c;
        else {
            delete clean.chain;
            ignoredArgs.push("chain");
        }
    }
    const clampInt = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Math.floor(Number(v)) : d));
    if (name === "get_transactions") clean.limit = clampInt(clean.limit, 1, 20, 10);
    if (name === "search_docs" || name === "search_code") clean.k = clampInt(clean.k, 1, 5, 3);
    for (const k of ["query", "hash", "address", "cursor"]) if (clean[k] !== undefined) clean[k] = String(clean[k]).slice(0, 300);
    return { args: clean, ignoredArgs };
};

/* ------------------------------------------------------------------ data sources (existing modules, lazy) */
const defaultSources = {
    eth: () => require("../../etherscan/modules/etherscan-scrapping.module"),
    sol: () => require("../../Solana/modules/solana-scrapping.module"),
    btc: () => require("../../bitcoin/modules/bitcoin-scrapping.module"),
    tagsSearch: () => require("../../Tags/modules/tags-search.module"),
    myTags: () => require("../../Tags/modules/my-tags.module"),
    license: () => require("../../License/modules/license.module"),
    http: () => axios,
    config: () => require("../../../Core/config"),
};

const userAddressFor = (zai, chain) => {
    const a = zai?.addresses || {};
    if (chain === "eth") return a.eth || null;
    if (chain === "sol") return a.solana || a.sol || null;
    if (chain === "btc") return a.btc || null;
    return null;
};
const splitName = (zelfName) => {
    const s = String(zelfName || "");
    const i = s.lastIndexOf(".");
    return i > 0 ? { tagName: s.slice(0, i), domain: s.slice(i + 1) } : { tagName: s, domain: "zelf" };
};
const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
const toIso = (v) => {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    const d = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(v);
    return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
};
const pick = (o, keys) => {
    for (const k of keys) if (o && o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
    return undefined;
};

/* ------------------------------------------------------------------ normalizers */
const normStatus = (t) => {
    const s = String(t?.status ?? t?.state ?? "").toLowerCase();
    if (t?.confirmed === false || /pend/.test(s)) return "pending";
    if (String(t?.isError) === "1" || t?.isError === true || String(t?.txreceipt_status) === "0" || t?.err) return "failed";
    if (/fail|error|revert/.test(s)) return "failed";
    return "success";
};

const normTx = (t, chain, mine) => {
    if (!t || typeof t !== "object") return null;
    const hash = pick(t, ["hash", "txHash", "txid", "signature", "id", "transactionHash"]);
    if (!hash) return null;
    const from = pick(t, ["from", "sender", "fromAddress"]);
    const to = pick(t, ["to", "receiver", "toAddress"]);
    const fromStr = typeof from === "string" ? from : from?.address;
    const toStr = typeof to === "string" ? to : to?.address;
    let type = pick(t, ["type", "traffic", "direction", "method"]);
    if (!type && mine) {
        const m = String(mine).toLowerCase();
        if (String(fromStr || "").toLowerCase() === m) type = "send";
        else if (String(toStr || "").toLowerCase() === m) type = "receive";
    }
    const error = pick(t, ["error", "errorMessage", "err"]);
    return {
        hash: String(hash),
        chain,
        type: type ? String(type).toLowerCase() : "unknown",
        status: normStatus(t),
        amount: String(pick(t, ["amount", "value", "valueFormatted", "amountFormatted"]) ?? ""),
        symbol: String(pick(t, ["symbol", "asset", "tokenSymbol", "currency"]) ?? { eth: "ETH", sol: "SOL", btc: "BTC" }[chain]),
        from: fromStr || null,
        to: toStr || null,
        fee: pick(t, ["fee", "fees", "txFee", "gasFee"]) !== undefined ? String(pick(t, ["fee", "fees", "txFee", "gasFee"])) : null,
        timestamp: toIso(pick(t, ["timestamp", "date", "blockTime", "time", "blockTimestamp", "age"])),
        ...(error ? { error: String(error) } : {}),
    };
};

const listFrom = (data) => {
    if (Array.isArray(data)) return data;
    for (const k of ["transactions", "items", "data", "result", "txs"]) if (Array.isArray(data?.[k])) return data[k];
    if (Array.isArray(data?.data?.transactions)) return data.data.transactions;
    return [];
};

/* ------------------------------------------------------------------ tool implementations */
const fetchChainTransactions = async (sources, chain, address, limit) => {
    if (chain === "eth") return listFrom(await sources.eth().getTransactionsList({ address, show: String(limit) }));
    if (chain === "sol") return listFrom(await sources.sol().getTransactions({ id: address, address }, { show: String(limit), limit }));
    if (chain === "btc") return listFrom(await sources.btc().getTransactionsList({ id: address }, { show: String(limit) }));
    return [];
};

const impl = {
    async get_account(_args, zai, sources) {
        const { tagName, domain } = splitName(zai.zelfName);
        let plan = null;
        let term = null;
        let expiresAt = null;
        try {
            const res = await sources.tagsSearch().searchTag({ tagName, domain }, {});
            const records = [...(res?.ipfs || []), ...(res?.arweave || []), ...(Array.isArray(res) ? res : [])];
            const rec = records.find((r) => r?.publicData) || records[0];
            const pd = rec?.publicData || {};
            plan = pd.type || pd.plan || null;
            term = pd.duration ? `${pd.duration} year(s)` : pd.term || null;
            expiresAt = toIso(pd.expiresAt || pd.leaseExpiresAt || pd.expires || rec?.expiresAt) || null;
        } catch (_) {
            /* account lookup is best-effort; addresses come from the token anyway */
        }
        return { zelfName: zai.zelfName, plan, term, expiresAt, addresses: { ...(zai.addresses || {}) } };
    },

    async get_balances({ chain }, zai, sources) {
        const chains = chain ? [chain] : SUPPORTED_CHAINS;
        const out = [];
        for (const c of chains) {
            const address = userAddressFor(zai, c);
            if (!address) continue;
            try {
                if (c === "eth") {
                    const d = await sources.eth().getAddress({ address });
                    for (const t of d?.tokens || d?.balance?.tokens || []) {
                        out.push({
                            chain: c,
                            token: t.address || t.contractAddress || t.symbol || "native",
                            symbol: t.symbol || t.tokenSymbol || "?",
                            amount: String(t.amount ?? t.balance ?? ""),
                            usdValue: num(t.fiatBalance ?? t.usdValue ?? t.value),
                        });
                    }
                    if (!out.some((r) => r.chain === "eth")) out.push({ chain: c, token: "native", symbol: "ETH", amount: String(d?.balance ?? "0"), usdValue: num(d?.fiatBalance) });
                } else if (c === "sol") {
                    const d = await sources.sol().getAddress({ id: address, address });
                    out.push({ chain: c, token: "native", symbol: "SOL", amount: String(d?.balance ?? "0"), usdValue: num(d?.fiatBalance) });
                    for (const t of d?.tokenHoldings?.tokens || d?.tokens || []) {
                        if (String(t.symbol).toUpperCase() === "SOL") continue;
                        out.push({ chain: c, token: t.mint || t.address || t.symbol, symbol: t.symbol || "?", amount: String(t.amount ?? t.balance ?? ""), usdValue: num(t.fiatBalance ?? t.usdValue) });
                    }
                } else if (c === "btc") {
                    const d = await sources.btc().getBalance({ id: address });
                    out.push({ chain: c, token: "native", symbol: "BTC", amount: String(d?.balance ?? "0"), usdValue: num(d?.fiatBalance) });
                }
            } catch (_) {
                out.push({ chain: c, token: "native", symbol: c.toUpperCase(), amount: null, usdValue: null, error: "unavailable" });
            }
        }
        return out;
    },

    async get_transactions({ chain, limit = 10, cursor }, zai, sources) {
        const chains = chain ? [chain] : SUPPORTED_CHAINS;
        const offset = Math.max(0, Number(cursor) || 0);
        let items = [];
        for (const c of chains) {
            const address = userAddressFor(zai, c);
            if (!address) continue;
            try {
                const raw = await fetchChainTransactions(sources, c, address, Math.min(20, offset + limit));
                items.push(...raw.map((t) => normTx(t, c, address)).filter(Boolean));
            } catch (_) {
                /* one chain failing must not hide the others */
            }
        }
        items.sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));
        const page = items.slice(offset, offset + limit);
        return { items: page, nextCursor: items.length > offset + limit ? String(offset + limit) : null };
    },

    async get_transaction({ hash, chain }, zai, sources) {
        const address = userAddressFor(zai, chain);
        if (!address || !hash) return { error: "not_found" };
        let raw = null;
        try {
            if (chain === "eth") raw = (await sources.eth().getTransactionStatus({ id: hash })) || null;
            else if (chain === "sol") raw = await sources.sol().getTransaction({ id: hash, signature: hash }, {});
            else if (chain === "btc") raw = await sources.btc().getTransactionDetail({ id: hash });
        } catch (_) {
            raw = null;
        }
        const tx = normTx(raw?.transaction || raw?.data || raw, chain, address);
        const mine = String(address).toLowerCase();
        const involved =
            tx && [tx.from, tx.to].some((a) => String(a || "").toLowerCase() === mine) ||
            (raw && JSON.stringify(raw).toLowerCase().includes(mine));
        if (!tx || !involved) return { error: "not_found" };
        const summary = `${tx.type} of ${tx.amount || "?"} ${tx.symbol} on ${chain}, status ${tx.status}${tx.error ? ` (${tx.error})` : ""}`;
        return { ...tx, summary };
    },

    async get_referrals(_args, zai, sources) {
        const { tagName, domain } = splitName(zai.zelfName);
        const res = await sources.myTags().getMyReferrals(tagName, domain, { tagName: zai.zelfName });
        const list = Array.isArray(res) ? res : res?.referrals || res?.items || [];
        const names = new Map();
        for (const r of list) if (r?.name && !names.has(r.name)) names.set(r.name, toIso(r.createdAt || r.date || r.publicData?.registeredAt || r.timestamp));
        return { count: names.size, items: [...names].map(([zelfName, date]) => ({ zelfName, date })) };
    },

    async get_pricing(_args, zai, sources) {
        const { domain } = splitName(zai.zelfName);
        const rec = await sources.license().searchLicense({ domain, withJSON: true });
        const cfg = rec?.domainConfig || {};
        const plans = {};
        for (const [k, v] of Object.entries(cfg)) if (/pric|plan|subscription|currency|discount|duration|tier/i.test(k)) plans[k] = v;
        return { source: "license-json-ipfs", domain, url: rec?.url || null, plans };
    },

    async search_docs(args, _zai, sources, opts) {
        return searchDocs(args, sources, opts?.locale);
    },

    async search_code({ query, k = 3 }, _zai, sources) {
        const token = process.env.ZAI_GITHUB_TOKEN;
        if (!token) return { items: [], note: "code_search_unavailable" };
        const q = `${String(query).replace(/[^\w .\-/]/g, " ")} ${PUBLIC_CODE_REPOS.map((r) => `repo:${r}`).join(" ")}`;
        const { data } = await sources.http().get("https://api.github.com/search/code", {
            params: { q, per_page: k },
            headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.text-match+json" },
            timeout: 8000,
        });
        return (data?.items || [])
            .filter((i) => PUBLIC_CODE_REPOS.includes(i.repository?.full_name) && i.repository?.private === false)
            .slice(0, k)
            .map((i) => ({ repo: i.repository.full_name, path: i.path, url: i.html_url, snippet: (i.text_matches?.[0]?.fragment || "").slice(0, 400) }));
    },

    async search_contracts({ query, address, chain }, _zai, sources) {
        if (chain !== "eth") return { items: [], note: "chain_not_supported" };
        const target = /^0x[0-9a-fA-F]{40}$/.test(address || "") ? address : /^0x[0-9a-fA-F]{40}$/.test(query || "") ? query : null;
        if (!target) return { items: [], note: "address_required" };
        const apiKey = sources.config()?.etherscan?.apiKey;
        if (!apiKey) return { items: [], note: "contract_lookup_unavailable" };
        const { data } = await sources.http().get("https://api.etherscan.io/v2/api", {
            params: { chainid: 1, module: "contract", action: "getsourcecode", address: target, apikey: apiKey },
            timeout: 8000,
        });
        const r = Array.isArray(data?.result) ? data.result[0] : null;
        if (!r) return { items: [] };
        const verified = !!r.SourceCode;
        return {
            items: [
                {
                    address: target,
                    chain,
                    name: r.ContractName || null,
                    verified,
                    summary: verified ? `${r.ContractName} (${r.CompilerVersion}${r.Proxy === "1" ? ", proxy" : ""})` : "Source not verified",
                    sourceUrl: `https://etherscan.io/address/${target}#code`,
                },
            ],
        };
    },
};

/* ------------------------------------------------------------------ docs index (public repo + live sitemap) */
const DOCS_SITE = "https://docs.zelf.world";
const SITEMAP_URL = `${DOCS_SITE}/sitemap.xml`;
const SITEMAP_TTL_MS = Number(process.env.ZAI_DOCS_SITEMAP_TTL_MS || 60 * 60 * 1000);
const SITEMAP_RETRY_MS = 5 * 60 * 1000;
const DOCS_TTL_MS = 60 * 60 * 1000;

const normPath = (p) => {
    const clean = String(p || "").replace(/[?#].*$/, "").replace(/\/+$/, "");
    return clean || "/";
};

let _sitemap = { at: 0, paths: null, failedAt: 0 };
/**
 * Set of URL paths published on docs.zelf.world (cached with TTL).
 * On fetch failure keeps the last good copy; with none, returns null (search_docs then returns no results,
 * so we never emit a link that could 404).
 */
const loadSitemap = async (sources) => {
    const now = Date.now();
    if (_sitemap.paths && now - _sitemap.at < SITEMAP_TTL_MS) return _sitemap.paths;
    if (_sitemap.failedAt && now - _sitemap.failedAt < SITEMAP_RETRY_MS) return _sitemap.paths;
    try {
        const { data } = await sources.http().get(SITEMAP_URL, { timeout: 8000, responseType: "text" });
        const paths = new Set();
        for (const m of String(data).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
            try {
                const u = new URL(m[1]);
                if (u.origin === DOCS_SITE) paths.add(normPath(decodeURIComponent(u.pathname)));
            } catch (_) {
                /* skip bad loc */
            }
        }
        if (!paths.size) throw new Error("empty_sitemap");
        _sitemap = { at: now, paths, failedAt: 0 };
    } catch (_) {
        _sitemap = { ..._sitemap, failedAt: now };
    }
    return _sitemap.paths;
};

const frontmatter = (body) => {
    const m = String(body).match(/^---\s*\n([\s\S]*?)\n---/);
    const fm = {};
    if (!m) return fm;
    for (const line of m[1].split("\n")) {
        const kv = line.match(/^(\w+):\s*(.+?)\s*$/);
        if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
    }
    return fm;
};

/**
 * Candidate site paths for a repo file, Docusaurus-style: route base = top folder (docs / docs-es),
 * number prefixes stripped from every segment, index/README collapse to the folder, frontmatter slug honored
 * (absolute slug is relative to the route base; relative slug replaces the last segment).
 */
const candidatePaths = (repoPath, fm = {}) => {
    const parts = repoPath.replace(/\.mdx?$/, "").split("/");
    const root = parts.shift();
    const strip = (seg) => seg.replace(/^\d+[-_.]\s*/, "");
    let segs = parts.map(strip);
    if (/^(index|readme)$/i.test(segs[segs.length - 1] || "")) segs.pop();
    const out = [];
    if (fm.id && !fm.slug) out.push([...segs.slice(0, -1), fm.id]);
    if (fm.slug) {
        const slug = fm.slug.replace(/\/+$/, "");
        if (slug.startsWith("/")) out.push(slug.split("/").filter(Boolean));
        else out.push([...segs.slice(0, -1), ...slug.split("/").filter(Boolean)]);
    }
    out.push(segs);
    return [...new Set(out.map((s) => normPath(`/${[root, ...s].join("/")}`)))];
};

/** Resolve a repo file to a published URL, or null if the sitemap does not have it. */
const resolveDocUrl = (repoPath, fm, sitemap) => {
    if (!sitemap) return null;
    for (const c of candidatePaths(repoPath, fm)) if (sitemap.has(c)) return `${DOCS_SITE}${c}`;
    return null;
};

let _docsCache = { at: 0, docs: null };
const loadDocsIndex = async (sources) => {
    if (_docsCache.docs && Date.now() - _docsCache.at < DOCS_TTL_MS) return _docsCache.docs;
    const http = sources.http();
    const { data } = await http.get(`https://api.github.com/repos/${DOCS_REPO}/git/trees/HEAD?recursive=1`, { timeout: 8000 });
    const paths = (data?.tree || []).map((t) => t.path).filter((p) => /^docs(-es)?\/.*\.mdx?$/.test(p)).slice(0, 400);
    const docs = [];
    await Promise.all(
        paths.map(async (repoPath) => {
            try {
                const { data: text } = await http.get(`https://raw.githubusercontent.com/${DOCS_REPO}/HEAD/${repoPath}`, { timeout: 8000, responseType: "text" });
                const body = String(text);
                const fm = frontmatter(body);
                const title = (fm.title || (body.match(/^#\s+(.+)$/m) || [])[1] || repoPath).trim();
                docs.push({ title, repoPath, fm, lang: repoPath.startsWith("docs-es/") ? "es" : "en", body: body.replace(/^---[\s\S]*?\n---/, "") });
            } catch (_) {
                /* skip */
            }
        })
    );
    _docsCache = { at: Date.now(), docs };
    return docs;
};

const scoreDocs = (docs, query, k, locale = "en") => {
    const terms = String(query || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 2);
    if (!terms.length) return [];
    const wantEs = /^es\b/i.test(String(locale || ""));
    return docs
        .map((d) => {
            const lower = d.body.toLowerCase();
            const titleLower = d.title.toLowerCase();
            let score = 0;
            for (const t of terms) score += lower.split(t).length - 1 + (titleLower.includes(t) ? 5 : 0);
            const at = Math.max(0, lower.indexOf(terms[0]) - 80);
            return { ...d, score, preferred: (d.lang === "es") === wantEs, snippet: d.body.slice(at, at + 300).replace(/\s+/g, " ").trim() };
        })
        .filter((d) => d.score > 0 && d.url)
        .sort((a, b) => Number(b.preferred) - Number(a.preferred) || b.score - a.score)
        .slice(0, k);
};

/** search_docs: only results whose URL is in the live sitemap; locale "es" prefers /docs-es/ pages. */
const searchDocs = async ({ query, k = 3 }, sources, locale) => {
    const [docs, sitemap] = await Promise.all([loadDocsIndex(sources), loadSitemap(sources)]);
    if (!sitemap) return { items: [], note: "docs_unavailable" };
    const withUrls = docs.map((d) => ({ ...d, url: resolveDocUrl(d.repoPath, d.fm, sitemap) }));
    return scoreDocs(withUrls, query, k, locale).map(({ title, url, snippet }) => ({ title, url, snippet }));
};

/* ------------------------------------------------------------------ cards (from tool results only) */
const MAX_CARDS_PER_TOOL = 5;
const cardsFor = (name, result) => {
    if (!result || result.error) return [];
    const txCard = (t) => ({
        type: "transaction",
        hash: t.hash,
        chain: t.chain,
        status: t.status,
        amount: t.amount,
        symbol: t.symbol,
        timestamp: t.timestamp,
        explorerUrl: EXPLORERS[t.chain] ? EXPLORERS[t.chain](t.hash) : null,
    });
    if (name === "get_transaction" && result.hash) return [txCard(result)];
    if (name === "get_transactions") return (result.items || []).slice(0, MAX_CARDS_PER_TOOL).map(txCard);
    if (name === "get_balances" && Array.isArray(result))
        return result
            .filter((b) => b.amount !== null && !b.error)
            .slice(0, MAX_CARDS_PER_TOOL)
            .map((b) => ({ type: "balance", chain: b.chain, symbol: b.symbol, amount: b.amount, usdValue: b.usdValue ?? null }));
    if (name === "search_docs" && Array.isArray(result)) return result.slice(0, MAX_CARDS_PER_TOOL).map((d) => ({ type: "doc", title: d.title, url: d.url }));
    return [];
};

/* ------------------------------------------------------------------ executor */
/**
 * Run one tool call for the verified identity.
 * @returns {Promise<{ name, result, cards, ignoredArgs }>} result is already redacted.
 */
const runTool = async (name, rawArgs, zai, sources = defaultSources, opts = {}) => {
    if (!TOOL_NAMES.has(name)) return { name, result: { error: "unknown_tool" }, cards: [], ignoredArgs: [] };
    if (!zai?.zelfName) return { name, result: { error: "no_identity" }, cards: [], ignoredArgs: [] };
    const { args, ignoredArgs } = scopeArgs(name, rawArgs);
    let result;
    try {
        result = await impl[name](args, zai, sources || defaultSources, opts);
    } catch (_) {
        result = { error: "tool_unavailable" };
    }
    result = redactDeep(result);
    const cards = cardsFor(name, result);
    if (ignoredArgs.length && result && typeof result === "object" && !Array.isArray(result)) {
        result = { ...result, note: "Identity arguments are ignored; results are always for the signed-in account only." };
    } else if (ignoredArgs.length) {
        result = { items: result, note: "Identity arguments are ignored; results are always for the signed-in account only." };
    }
    return { name, result, cards, ignoredArgs };
};

module.exports = {
    MAX_TOOL_CALLS_PER_TURN,
    definitions,
    runTool,
    _internal: {
        scopeArgs,
        normTx,
        cardsFor,
        scoreDocs,
        candidatePaths,
        resolveDocUrl,
        loadSitemap,
        userAddressFor,
        defaultSources,
        resetDocsCache: () => {
            _docsCache = { at: 0, docs: null };
            _sitemap = { at: 0, paths: null, failedAt: 0 };
        },
    },
};
