jest.mock("../../Repositories/ZAI/models/zai-revoked-token.model", () => ({ exists: jest.fn(async () => null), updateOne: jest.fn() }));

const Koa = require("koa");
const Router = require("koa-router");
const { koaBody } = require("koa-body");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const Tools = require("../../Repositories/ZAI/modules/zai-tools.module");
const Chat = require("../../Repositories/ZAI/modules/zai-chat.module");
const Redaction = require("../../Repositories/ZAI/modules/zai-redaction.module");

const ZAI = { zelfName: "miguel.zelf", zid: "bafy1", addresses: { eth: "0xMine", solana: "SoMine", btc: "bc1mine" } };

const mockSources = () => {
    const calls = [];
    const rec = (name) => (...args) => {
        calls.push({ name, args });
        return impls[name](...args);
    };
    const impls = {
        ethGetAddress: async () => ({ balance: 1.5, fiatBalance: 3000, tokens: [{ symbol: "ETH", amount: 1.5, fiatBalance: 3000 }] }),
        ethTxs: async () => ({ transactions: [{ hash: "0xh1", from: "0xMine", to: "0xOther", value: "0.1", isError: "1", timestamp: 1760000000 }] }),
        ethTx: async ({ id }) => (id === "0xmine-tx" ? { hash: id, from: "0xOther", to: "0xMine", value: "2" } : { hash: id, from: "0xA", to: "0xB", value: "9" }),
        referrals: async () => [{ name: "ana.zelf", createdAt: "2026-10-01" }, { name: "ana.zelf" }, { name: "bob.zelf" }],
        license: async () => ({ url: "https://ipfs/x", domainConfig: { price: { "1": 10 }, name: "zelf", secretStuff: "x" } }),
        searchTag: async () => ({ ipfs: [{ publicData: { type: "mainnet", duration: "1", expiresAt: "2027-10-01" } }] }),
    };
    return {
        calls,
        sources: {
            eth: () => ({ getAddress: rec("ethGetAddress"), getTransactionsList: rec("ethTxs"), getTransactionStatus: rec("ethTx") }),
            sol: () => ({ getAddress: async () => ({ balance: 0 }), getTransactions: async () => [], getTransaction: async () => null }),
            btc: () => ({ getBalance: async () => ({ balance: 0 }), getTransactionsList: async () => ({ transactions: [] }), getTransactionDetail: async () => null }),
            myTags: () => ({ getMyReferrals: rec("referrals") }),
            license: () => ({ searchLicense: rec("license") }),
            tagsSearch: () => ({ searchTag: rec("searchTag") }),
            http: () => ({ get: async () => ({ data: {} }) }),
            config: () => ({ etherscan: {} }),
        },
    };
};

/** Scripted OpenAI-compatible model: each round returns the next script entry. */
describe("zAI tools: scoping", () => {
    test("identity args from the model are dropped; data is always for the token's Zelf ID", async () => {
        const { sources, calls } = mockSources();
        const r = await Tools.runTool("get_balances", JSON.stringify({ zelfName: "alice.zelf", address: "0xAlice", chain: "eth" }), ZAI, sources);
        expect(r.ignoredArgs.sort()).toEqual(["address", "zelfName"]);
        expect(calls[0].args[0]).toEqual({ address: "0xMine" });
        expect(JSON.stringify(r.result)).not.toMatch(/alice|0xAlice/i);
    });

    test("get_referrals / get_account ignore a tagName and use the token's name", async () => {
        const { sources, calls } = mockSources();
        const r = await Tools.runTool("get_referrals", { tagName: "alice", domain: "evil" }, ZAI, sources);
        expect(calls[0].args.slice(0, 2)).toEqual(["miguel", "zelf"]);
        expect(r.result.count).toBe(2);
        expect(r.result.note).toMatch(/signed-in account only/);
        const a = await Tools.runTool("get_account", { zelfName: "alice.zelf" }, ZAI, sources);
        expect(a.result).toMatchObject({ zelfName: "miguel.zelf", plan: "mainnet", addresses: ZAI.addresses });
    });

    test("get_transaction returns not_found unless it involves the user's address", async () => {
        const { sources } = mockSources();
        expect((await Tools.runTool("get_transaction", { hash: "0xforeign", chain: "eth" }, ZAI, sources)).result).toEqual({ error: "not_found" });
        const mine = await Tools.runTool("get_transaction", { hash: "0xmine-tx", chain: "eth" }, ZAI, sources);
        expect(mine.result).toMatchObject({ hash: "0xmine-tx", type: "receive", summary: expect.any(String) });
        expect(mine.cards[0]).toMatchObject({ type: "transaction", explorerUrl: "https://etherscan.io/tx/0xmine-tx" });
    });

    test("get_transactions clamps limit to 20 and normalizes status", async () => {
        const { sources, calls } = mockSources();
        const r = await Tools.runTool("get_transactions", { chain: "eth", limit: 500 }, ZAI, sources);
        expect(calls[0].args[0]).toEqual({ address: "0xMine", show: "20" });
        expect(r.result.items[0]).toMatchObject({ hash: "0xh1", status: "failed", type: "send", chain: "eth" });
    });

    test("get_pricing reads only the license JSON (searchLicense) for the token's domain", async () => {
        const { sources, calls } = mockSources();
        const r = await Tools.runTool("get_pricing", {}, ZAI, sources);
        expect(calls[0].args[0]).toEqual({ domain: "zelf", withJSON: true });
        expect(r.result).toMatchObject({ source: "license-json-ipfs", plans: { price: { 1: 10 } } });
        expect(r.result.plans.secretStuff).toBeUndefined();
    });

    test("unknown tools and missing identity are refused", async () => {
        expect((await Tools.runTool("decrypt_tag", {}, ZAI)).result).toEqual({ error: "unknown_tool" });
        expect((await Tools.runTool("get_account", {}, {})).result).toEqual({ error: "no_identity" });
    });

    test("no tool definition accepts an identity parameter", () => {
        for (const d of Tools.definitions) {
            const props = Object.keys(d.function.parameters.properties);
            expect(props).not.toEqual(expect.arrayContaining(["zelfName"]));
            expect(props.filter((p) => /name|zid|tag|owner|user/i.test(p))).toEqual([]);
        }
    });
});

describe("zAI redaction", () => {
    test("scrubs JWTs, private keys, mnemonics, PGP, API keys and env secret values", () => {
        process.env.TEST_ZAI_SECRET_KEY = "super-secret-env-value-123";
        Redaction._internal.resetEnvCache();
        const input = [
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abcdefghijk",
            "a".repeat(64),
            "abandon ability able about above absent absorb abstract absurd abuse access accident",
            "-----BEGIN PGP MESSAGE-----\nxyz\n-----END PGP MESSAGE-----",
            "sk-abcdefghijklmnopqrstuv",
            "mongodb+srv://u:p@host/db",
            "super-secret-env-value-123",
        ].join(" | ");
        const out = Redaction.redact(input);
        expect(out).not.toMatch(/eyJhbGci|aaaaaaaa|abandon ability|BEGIN PGP|sk-abc|mongodb|super-secret/);
        delete process.env.TEST_ZAI_SECRET_KEY;
        Redaction._internal.resetEnvCache();
    });

    test("normal sentences are not treated as mnemonics", () => {
        const s = "you can check your balance from the wallet screen and then tap send to move funds";
        expect(Redaction.redact(s)).toBe(s);
    });
});

describe("search_docs: sitemap-backed URLs + locale", () => {
    const SITEMAP = `<?xml version="1.0"?><urlset>
        <url><loc>https://docs.zelf.world/docs/guides/recover-zelf-id</loc></url>
        <url><loc>https://docs.zelf.world/docs-es/guias/recuperar</loc></url>
        <url><loc>https://docs.zelf.world/docs/api/zelf-ids/decrypt</loc></url>
        <url><loc>https://docs.zelf.world/docs/intro</loc></url>
    </urlset>`;
    const FILES = {
        "docs/02-guides/01-recover-zelf-id.md": "---\ntitle: Recover your Zelf ID\n---\nRecover your Zelf ID with the QR recovery code.",
        "docs-es/guias/recuperacion.md": "---\ntitle: Recuperar tu Zelf ID\nslug: recuperar\n---\nRecover recuperar Zelf ID con el código QR.",
        "docs/api/tags/decrypt-tag.md": "---\ntitle: Decrypt\nslug: /api/zelf-ids/decrypt\n---\nDecrypt a Zelf ID; recover data.",
        "docs/guides/ghost.md": "---\ntitle: Ghost recover page\n---\nrecover recover recover recover (not published)",
        "docs/intro/index.md": "# Intro\nrecover intro",
    };
    const http = (overrides = {}) => {
        const calls = [];
        return {
            calls,
            get: jest.fn(async (url) => {
                calls.push(url);
                if (url.includes("sitemap.xml")) {
                    if (overrides.sitemapFails) throw new Error("ECONNRESET");
                    return { data: SITEMAP };
                }
                if (url.includes("/git/trees/")) return { data: { tree: Object.keys(FILES).map((path) => ({ path })) } };
                const path = Object.keys(FILES).find((p) => url.endsWith(p));
                return { data: FILES[path] };
            }),
        };
    };
    const srcWith = (h) => ({ ...mockSources().sources, http: () => h });
    beforeEach(() => Tools._internal.resetDocsCache());

    test("URLs come from the sitemap (number prefixes stripped, slug honored, index collapsed); unpublished pages dropped", async () => {
        const r = await Tools.runTool("search_docs", { query: "recover", k: 5 }, ZAI, srcWith(http()), { locale: "en" });
        const urls = r.result.map((d) => d.url);
        expect(urls).toEqual(
            expect.arrayContaining([
                "https://docs.zelf.world/docs/guides/recover-zelf-id",
                "https://docs.zelf.world/docs/api/zelf-ids/decrypt",
                "https://docs.zelf.world/docs/intro",
            ])
        );
        expect(urls.some((u) => /ghost/.test(u))).toBe(false);
        expect(r.cards.every((c) => c.type === "doc" && !/ghost/.test(c.url))).toBe(true);
        expect(urls[0]).not.toMatch(/docs-es/);
    });

    test("locale es prefers /docs-es/ results (relative slug resolved)", async () => {
        const r = await Tools.runTool("search_docs", { query: "recover", k: 2 }, ZAI, srcWith(http()), { locale: "es-CO" });
        expect(r.result[0].url).toBe("https://docs.zelf.world/docs-es/guias/recuperar");
    });

    test("sitemap is cached with a TTL", async () => {
        const h = http();
        await Tools.runTool("search_docs", { query: "recover" }, ZAI, srcWith(h));
        await Tools.runTool("search_docs", { query: "recover" }, ZAI, srcWith(h));
        expect(h.calls.filter((u) => u.includes("sitemap.xml"))).toHaveLength(1);
    });

    test("sitemap fetch failure: no links at all (never a 404 card), no throw", async () => {
        const r = await Tools.runTool("search_docs", { query: "recover" }, ZAI, srcWith(http({ sitemapFails: true })));
        expect(r.result).toEqual({ items: [], note: "docs_unavailable" });
        expect(r.cards).toEqual([]);
    });

    test("candidatePaths handles prefixes, index, absolute and relative slugs", () => {
        const c = Tools._internal.candidatePaths;
        expect(c("docs/01-intro/index.md")).toEqual(["/docs/intro"]);
        expect(c("docs/a/02_b.mdx", { slug: "/x/y" })).toEqual(["/docs/x/y", "/docs/a/b"]);
        expect(c("docs-es/a/b.md", { slug: "c" })).toEqual(["/docs-es/a/c", "/docs-es/a/b"]);
    });
});

describe("chat locale (Joi body field or Accept-Language)", () => {
    const Middleware = require("../../Repositories/ZAI/middlewares/zai.middleware");
    const ctx = (body, headers = {}) => ({ request: { body }, headers, state: {} });
    beforeEach(() => {
        process.env.ZAI_ANGELA_WEBHOOK_URL = "https://angela.example/hook";
        process.env.ZAI_ANGELA_WEBHOOK_KEY = "k";
        process.env.ZAI_CALLBACK_SECRET = "s";
    });
    test("body locale wins; Accept-Language used otherwise; default en; bad value rejected", async () => {
        const next = jest.fn();
        const a = ctx({ message: "hi", locale: "es" }, { "accept-language": "en-US" });
        await Middleware.chatValidation(a, next);
        expect(a.request.body.locale).toBe("es");
        const b = ctx({ message: "hi" }, { "accept-language": "fr;q=0.5, es-CO;q=0.9, *;q=0.1" });
        await Middleware.chatValidation(b, next);
        expect(b.request.body.locale).toBe("es-co");
        const c = ctx({ message: "hi" });
        await Middleware.chatValidation(c, next);
        expect(c.request.body.locale).toBe("en");
        const d = ctx({ message: "hi", locale: "<script>" });
        await Middleware.chatValidation(d, next);
        expect(d.status).toBe(400);
        expect(next).toHaveBeenCalledTimes(3);
    });
});
