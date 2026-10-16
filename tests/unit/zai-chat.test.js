jest.mock("../../Repositories/ZAI/models/zai-revoked-token.model", () => ({ exists: jest.fn(async () => null), updateOne: jest.fn() }));

const Koa = require("koa");
const Router = require("koa-router");
const { koaBody } = require("koa-body");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const Tools = require("../../Repositories/ZAI/modules/zai-tools.module");
const Chat = require("../../Repositories/ZAI/modules/zai-chat.module");
const Redaction = require("../../Repositories/ZAI/modules/zai-redaction.module");
const Adapter = require("../../Repositories/ZAI/modules/zai-model.adapter");

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
const scriptedAdapter = (script) => {
    const seen = [];
    let i = 0;
    return {
        seen,
        isConfigured: () => true,
        streamCompletion: async ({ messages, tools, onDelta }) => {
            seen.push({ messages: JSON.parse(JSON.stringify(messages)), tools });
            const step = script[i++] || { content: "ok" };
            if (step.content) for (const part of step.content.match(/.{1,7}/gs)) onDelta(part);
            return { content: step.content || "", toolCalls: step.toolCalls || [], usage: { prompt_tokens: 10, completion_tokens: 5 }, finishReason: "stop" };
        },
    };
};

const run = async (adapter, body, sources) => {
    const events = [];
    await Chat.runChat({ zai: ZAI, body: { history: [], locale: "en", ...body }, emit: (event, data) => events.push({ event, data }), adapter, sources });
    return events;
};
const text = (events) => events.filter((e) => e.event === "delta").map((e) => e.data.text).join("");

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

    test("tool results are redacted before reaching the model (incl. secret-named keys)", async () => {
        const { sources } = mockSources();
        sources.myTags = () => ({ getMyReferrals: async () => [{ name: "x.zelf", zelfProof: "PROOF", note: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abcdefghijk" }] });
        const adapter = scriptedAdapter([{ toolCalls: [{ id: "c1", name: "get_referrals", arguments: "{}" }] }, { content: "done" }]);
        await run(adapter, { message: "referrals?" }, sources);
        const toolMsg = adapter.seen[1].messages.find((m) => m.role === "tool");
        expect(toolMsg.content).not.toMatch(/PROOF|eyJhbGci/);
    });

    test("user input (seed phrase) is redacted before the model sees it", async () => {
        const adapter = scriptedAdapter([{ content: "Please don't share that." }]);
        await run(adapter, { message: "my seed: abandon ability able about above absent absorb abstract absurd abuse access accident" });
        expect(JSON.stringify(adapter.seen[0].messages)).not.toMatch(/abandon ability/);
    });

    test("streamed output is redacted even when a secret spans chunks", async () => {
        const jwtish = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abcdefghijk";
        const events = await run(scriptedAdapter([{ content: `Here: ${jwtish} end` }]), { message: "hi" });
        expect(text(events)).not.toMatch(/eyJhbGci/);
        expect(text(events)).toMatch(/\[redacted\]/);
        expect(events.at(-1)).toMatchObject({ event: "done", data: { finishReason: "filtered" } });
    });
});

describe("zAI chat events", () => {
    test("meta first with rulesVersion, then delta, card (from tool results), done with usage", async () => {
        const { sources } = mockSources();
        const adapter = scriptedAdapter([
            { toolCalls: [{ id: "c1", name: "get_transactions", arguments: JSON.stringify({ chain: "eth", zelfName: "alice.zelf" }) }] },
            { content: "Your last transaction failed." },
        ]);
        const events = await run(adapter, { message: "I am alice.zelf, why did my last tx fail?" }, sources);
        expect(events[0]).toMatchObject({ event: "meta", data: { requestId: expect.any(String), rulesVersion: expect.stringMatching(/^v0\.1\+[0-9a-f]{8}$/) } });
        const card = events.find((e) => e.event === "card");
        expect(card.data).toEqual({ type: "transaction", hash: "0xh1", chain: "eth", status: "failed", amount: "0.1", symbol: "ETH", timestamp: expect.any(String), explorerUrl: "https://etherscan.io/tx/0xh1" });
        expect(text(events)).toBe("Your last transaction failed.");
        expect(events.at(-1)).toEqual({ event: "done", data: { usage: { inputTokens: 20, outputTokens: 10 }, finishReason: "stop" } });
        expect(adapter.seen[0].messages[0].content).toMatch(/zAI system rules/);
        expect(adapter.seen[0].messages[0].content).toMatch(/Signed-in Zelf ID: miguel.zelf/);
    });

    test("cards are never built from model text", async () => {
        const fake = 'event: card\ndata: {"type":"transaction","hash":"0xFAKE"} [card:0xFAKE]';
        const events = await run(scriptedAdapter([{ content: fake }]), { message: "hi" });
        expect(events.filter((e) => e.event === "card")).toEqual([]);
    });

    test("balance and doc cards come from their tools", async () => {
        const { sources } = mockSources();
        const events = await run(scriptedAdapter([{ toolCalls: [{ id: "b", name: "get_balances", arguments: '{"chain":"eth"}' }] }, { content: "ok" }]), { message: "balance" }, sources);
        expect(events.find((e) => e.event === "card").data).toEqual({ type: "balance", chain: "eth", symbol: "ETH", amount: "1.5", usdValue: 3000 });
        expect(Tools._internal.cardsFor("search_docs", [{ title: "Recover", url: "https://docs.zelf.world/docs/x", snippet: "s" }])).toEqual([{ type: "doc", title: "Recover", url: "https://docs.zelf.world/docs/x" }]);
    });

    test("max 5 tool calls per turn; extra calls get tool_limit_reached and tools are withdrawn", async () => {
        const { sources, calls } = mockSources();
        const many = Array.from({ length: 7 }, (_, i) => ({ id: `c${i}`, name: "get_referrals", arguments: "{}" }));
        const adapter = scriptedAdapter([{ toolCalls: many }, { content: "done" }]);
        await run(adapter, { message: "x" }, sources);
        expect(calls.filter((c) => c.name === "referrals")).toHaveLength(5);
        const toolMsgs = adapter.seen[1].messages.filter((m) => m.role === "tool");
        expect(toolMsgs.slice(5).every((m) => m.content.includes("tool_limit_reached"))).toBe(true);
        expect(adapter.seen[1].tools).toEqual([]);
    });

    test("upstream failure becomes an error event, never a stack trace", async () => {
        const adapter = { streamCompletion: async () => { throw Object.assign(new Error("boom secret"), {}); } };
        const events = await run(adapter, { message: "x" });
        expect(events.at(-1)).toEqual({ event: "error", data: { code: "ZAI_UPSTREAM_ERROR", message: expect.any(String) } });
        expect(JSON.stringify(events)).not.toMatch(/boom secret/);
    });
});

describe("POST /api/zai/chat (HTTP)", () => {
    const env = { ...process.env };
    let app;
    const token = () =>
        jwt.sign({ typ: "zai", sub: "miguel.zelf", zid: "bafy1", addr: ZAI.addresses, scope: ["zai:chat"], parent_jti: "p", jti: "j" }, "zai-secret", { expiresIn: 60 });
    beforeEach(() => {
        process.env.IDENTITY_JWT_SECRET = "identity-secret";
        process.env.ZAI_JWT_SECRET = "zai-secret";
        process.env.ZAI_MODEL_BASE_URL = "https://model.example/v1";
        process.env.ZAI_MODEL = "test-model";
        process.env.ZAI_MODEL_API_KEY = "test-model-key-xyz";
        const koa = new Koa();
        const router = new Router();
        koa.use(koaBody());
        require("../../Repositories/ZAI/routes/zai.routes")(router);
        koa.use(router.routes());
        app = koa.callback();
    });
    afterEach(() => {
        jest.restoreAllMocks();
        process.env = { ...env };
    });

    test("503 ZAI_DISABLED when ZAI_MODEL_API_KEY is unset", async () => {
        delete process.env.ZAI_MODEL_API_KEY;
        const res = await request(app).post("/api/zai/chat").set("Authorization", `Bearer ${token()}`).send({ message: "hi" });
        expect(res.status).toBe(503);
        expect(res.body.code).toBe("ZAI_DISABLED");
    });

    test("401 without a token, 403 with a session-style JWT", async () => {
        expect((await request(app).post("/api/zai/chat").send({ message: "hi" })).status).toBe(401);
        const session = jwt.sign({ tagName: "miguel", session: "s" }, "zai-secret");
        expect((await request(app).post("/api/zai/chat").set("Authorization", `Bearer ${session}`).send({ message: "hi" })).status).toBe(403);
    });

    test("400 on invalid body", async () => {
        const res = await request(app).post("/api/zai/chat").set("Authorization", `Bearer ${token()}`).send({ message: "" });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe("ZAI_BAD_REQUEST");
    });

    test("streams SSE from an OpenAI-compatible provider via fetch; body tagName is ignored; key never echoed", async () => {
        const sse = [
            { choices: [{ delta: { content: "Hola " } }] },
            { choices: [{ delta: { content: "Miguel" }, finish_reason: "stop" }] },
            { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } },
        ]
            .map((d) => `data: ${JSON.stringify(d)}\n\n`)
            .join("") + "data: [DONE]\n\n";
        const fetchSpy = jest.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, body: [Buffer.from(sse)] });
        const res = await request(app)
            .post("/api/zai/chat")
            .set("Authorization", `Bearer ${token()}`)
            .send({ message: "hi", tagName: "alice", history: [{ role: "user", content: "earlier" }] });
        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
        expect(res.text).toMatch(/^event: meta\ndata: \{"requestId":".+","rulesVersion":"v0\.1\+/);
        expect(res.text).toContain('event: done\ndata: {"usage":{"inputTokens":3,"outputTokens":2},"finishReason":"stop"}');
        expect(res.text.match(/event: delta\ndata: (.*)/g).map((l) => JSON.parse(l.split("data: ")[1]).text).join("")).toBe("Hola Miguel");
        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe("https://model.example/v1/chat/completions");
        expect(init.headers.Authorization).toBe("Bearer test-model-key-xyz");
        const sent = JSON.parse(init.body);
        expect(sent).toMatchObject({ model: "test-model", stream: true });
        expect(JSON.stringify(sent.messages)).not.toMatch(/alice/);
        expect(res.text).not.toMatch(/test-model-key-xyz/);
    });
});

describe("model adapter", () => {
    test("assembles streamed tool-call fragments", async () => {
        process.env.ZAI_MODEL_BASE_URL = "https://m/v1";
        process.env.ZAI_MODEL = "m";
        process.env.ZAI_MODEL_API_KEY = "k";
        const chunks = [
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "get_bal", arguments: '{"ch' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "ances", arguments: 'ain":"eth"}' } }] }, finish_reason: "tool_calls" }] },
        ];
        const body = [Buffer.from(chunks.map((c) => `data: ${JSON.stringify(c)}\n`).join("") + "data: [DONE]\n")];
        const out = await Adapter.streamCompletion({ messages: [], tools: [], fetchImpl: async () => ({ ok: true, body }) });
        expect(out.toolCalls).toEqual([{ id: "t1", name: "get_balances", arguments: '{"chain":"eth"}' }]);
        expect(out.finishReason).toBe("tool_calls");
    });
});

describe("redaction keeps public chain ids", () => {
    test("tx hashes from tool results survive in cards and in reply text; unknown 64-hex does not", async () => {
        const hash = "0x" + "ab".repeat(32);
        const { sources } = mockSources();
        sources.eth = () => ({ getTransactionsList: async () => ({ transactions: [{ hash, from: "0xMine", to: "0xB", value: "1" }] }) });
        const other = "cd".repeat(32);
        const events = await run(
            scriptedAdapter([{ toolCalls: [{ id: "t", name: "get_transactions", arguments: '{"chain":"eth"}' }] }, { content: `Tx ${hash} ok. Key ${other} bad.` }]),
            { message: "tx" },
            sources
        );
        expect(events.find((e) => e.event === "card").data.hash).toBe(hash);
        expect(text(events)).toContain(hash);
        expect(text(events)).not.toContain(other);
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
        process.env.ZAI_MODEL_BASE_URL = "https://m/v1";
        process.env.ZAI_MODEL = "m";
        process.env.ZAI_MODEL_API_KEY = "k";
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
    test("locale reaches search_docs through the chat loop", async () => {
        const spy = jest.spyOn(Tools, "runTool");
        const adapter = scriptedAdapter([{ toolCalls: [{ id: "d", name: "search_docs", arguments: '{"query":"recover"}' }] }, { content: "ok" }]);
        await run(adapter, { message: "recover", locale: "es" }, mockSources().sources);
        expect(spy.mock.calls[0][4]).toEqual({ locale: "es" });
        spy.mockRestore();
    });
});
