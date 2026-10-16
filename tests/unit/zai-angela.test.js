process.env.ZAI_POLL_MS = "10";
jest.mock("../../Repositories/ZAI/models/zai-revoked-token.model", () => ({ exists: jest.fn(async () => null), updateOne: jest.fn() }));
jest.mock("../../Repositories/ZAI/models/zai-request.model", () => require("../zai/zai-request.mock"));
jest.mock("../../Repositories/etherscan/modules/etherscan-scrapping.module", () => ({
    getAddress: jest.fn(async ({ address }) => ({ balance: address === "0xMine" ? 2 : 999, fiatBalance: 10, tokens: [] })),
    getTransactionsList: jest.fn(async ({ address }) => ({ transactions: [{ hash: "0x" + "ab".repeat(32), from: address, to: "0xB", value: "1", isError: "1" }] })),
    getTransactionStatus: jest.fn(async () => null),
}));
jest.mock("axios", () => ({ get: jest.fn(async () => { throw new Error("offline"); }) }));

const crypto = require("crypto");
const Koa = require("koa");
const Router = require("koa-router");
const { koaBody } = require("koa-body");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const Store = require("../zai/zai-request.mock");
const Angela = require("../../Repositories/ZAI/modules/zai-angela.module");
const Chat = require("../../Repositories/ZAI/modules/zai-chat.module");
const Context = require("../../Repositories/ZAI/modules/zai-context.module");

const ADDR = { eth: "0xMine", solana: "SoMine", btc: "bc1mine" };
const SECRET = "callback-secret-for-tests-123456";
const sign = (raw, secret = SECRET) => crypto.createHmac("sha256", secret).update(raw).digest("hex");
const token = (sub = "miguel.zelf") => jwt.sign({ typ: "zai", sub, zid: "z", addr: ADDR, scope: ["zai:chat"], parent_jti: "p", jti: crypto.randomUUID() }, "zai-secret", { expiresIn: 300 });
const parseSse = (t) =>
    t
        .split("\n\n")
        .map((b) => b.match(/^event: (\w+)\ndata: (.*)$/s))
        .filter(Boolean)
        .map(([, event, data]) => ({ event, data: JSON.parse(data) }));

let app;
const env = { ...process.env };
beforeEach(() => {
    Store.__store.clear();
    Object.assign(process.env, {
        IDENTITY_JWT_SECRET: "identity-secret",
        ZAI_JWT_SECRET: "zai-secret",
        ZAI_ANGELA_WEBHOOK_URL: "https://angela.example/hook",
        ZAI_ANGELA_WEBHOOK_KEY: "angela-webhook-key-abcdef",
        ZAI_CALLBACK_SECRET: SECRET,
    });
    const koa = new Koa();
    const router = new Router();
    koa.use(koaBody({ includeUnparsed: true }));
    require("../../Repositories/ZAI/routes/zai.routes")(router);
    koa.use(router.routes());
    app = koa.callback();
});
afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...env };
});

const postCallback = (obj, sig) => {
    const raw = JSON.stringify(obj);
    return request(app).post("/api/zai/callback").set("Content-Type", "application/json").set("X-ZAI-Signature", sig ?? sign(raw)).send(raw);
};

/** Mock Angela: receives the webhook, answers through the real signed callback route. */
const mockAngela = (answer = (p) => `Hi ${p.zelfName}`, { statuses = [] } = {}) => {
    const payloads = [];
    const spy = jest.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const status = statuses.shift();
        if (status) return { ok: false, status };
        const payload = JSON.parse(init.body);
        payloads.push({ url, headers: init.headers, payload });
        setTimeout(() => postCallback({ requestId: payload.requestId, text: answer(payload) }).then(() => undefined), 5);
        return { ok: true, status: 202 };
    });
    return { payloads, spy };
};

describe("POST /api/zai/chat via Angela webhook", () => {
    test("503 ZAI_DISABLED if any of the three env vars is unset", async () => {
        for (const k of ["ZAI_ANGELA_WEBHOOK_URL", "ZAI_ANGELA_WEBHOOK_KEY", "ZAI_CALLBACK_SECRET"]) {
            const saved = process.env[k];
            delete process.env[k];
            const res = await request(app).post("/api/zai/chat").set("Authorization", `Bearer ${token()}`).send({ message: "hi" });
            expect([res.status, res.body.code]).toEqual([503, "ZAI_DISABLED"]);
            process.env[k] = saved;
        }
    });

    test("full flow: meta → status thinking → delta → cards (prefetched) → done; payload shape; secrets never leak", async () => {
        const { payloads } = mockAngela(() => 'Your last tx failed. {"type":"transaction","hash":"0xFAKE"} eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abcdefghijk');
        const res = await request(app)
            .post("/api/zai/chat")
            .set("Authorization", `Bearer ${token()}`)
            .set("Accept-Language", "es-CO")
            .send({ message: "I am alice.zelf, why did my last transaction fail? my seed abandon ability able about above absent absorb abstract absurd abuse access accident", tagName: "alice" });
        const events = parseSse(res.text);
        const names = events.map((e) => e.event);
        expect(names[0]).toBe("meta");
        expect(events[1]).toEqual({ event: "status", data: { state: "thinking" } });
        expect(names.at(-1)).toBe("done");
        expect(events.at(-1).data.finishReason).toBe("filtered");
        const text = events.filter((e) => e.event === "delta").map((e) => e.data.text).join("");
        expect(text).toMatch(/^Your last tx failed\./);
        expect(text).not.toMatch(/eyJhbGci/);
        const cards = events.filter((e) => e.event === "card").map((e) => e.data);
        expect(cards.some((c) => c.hash === "0xFAKE")).toBe(false);
        expect(cards[0]).toMatchObject({ type: "transaction", status: "failed", explorerUrl: expect.stringMatching(/^https:\/\/etherscan.io\/tx\//) });

        const { url, headers, payload } = payloads[0];
        expect(url).toBe("https://angela.example/hook");
        expect(headers.Authorization).toBe("Bearer angela-webhook-key-abcdef");
        expect(payload).toMatchObject({
            requestId: events[0].data.requestId,
            locale: "es-co",
            rulesVersion: events[0].data.rulesVersion,
            callbackUrl: "https://v4.zelf.world/api/zai/callback",
            zelfName: "miguel.zelf",
        });
        expect(new Date(payload.replyDeadline) - Date.now()).toBeGreaterThan(170 * 1000);
        expect(payload.toolContext.map((t) => t.tool)).toEqual(expect.arrayContaining(["get_transactions"]));
        const all = JSON.stringify(payload);
        expect(all).not.toMatch(/abandon ability|angela-webhook-key|callback-secret|tagName/);
        // the typed name is only in the question text; tools ran for the token's account
        expect(JSON.stringify(payload.toolContext.map((t) => t.result))).not.toMatch(/alice/);
        expect(payload.toolContext[0].result.items[0].from).toBe("0xMine");
        expect(res.text).not.toMatch(/angela-webhook-key|callback-secret/);
    });

    test("webhook retries 3 times on 408/429/5xx, then succeeds", async () => {
        const { spy } = mockAngela(undefined, { statuses: [429, 503, 408] });
        const out = await Angela.sendToAngela({ x: 1 }, { backoffMs: 1 });
        expect(out.attempts).toBe(4);
        expect(spy).toHaveBeenCalledTimes(4);
    });

    test("no retry on 400; exhausted retries → error event ZAI_UPSTREAM_ERROR and request marked failed", async () => {
        const spy = jest.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, status: 400 });
        await expect(Angela.sendToAngela({}, { backoffMs: 1 })).rejects.toMatchObject({ code: "ZAI_UPSTREAM_ERROR" });
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockResolvedValue({ ok: false, status: 502 });
        const events = [];
        await Chat.runChat({
            zai: { zelfName: "miguel.zelf", addresses: ADDR },
            body: { message: "hello", history: [], locale: "en" },
            emit: (e, d) => events.push({ e, d }),
            deps: { sendOpts: { backoffMs: 1 } },
            requestId: "11111111-1111-4111-8111-111111111111",
        });
        expect(events.at(-1)).toMatchObject({ e: "error", d: { code: "ZAI_UPSTREAM_ERROR" } });
        expect(Store.__store.get("11111111-1111-4111-8111-111111111111").status).toBe("failed");
    });

    test("no answer before the wait timeout → error ZAI_TIMEOUT (with requestId for pickup)", async () => {
        jest.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, status: 202 });
        const events = [];
        await Chat.runChat({
            zai: { zelfName: "miguel.zelf", addresses: ADDR },
            body: { message: "hello", history: [], locale: "en" },
            emit: (e, d) => events.push({ e, d }),
            deps: { waitOpts: { timeoutMs: 50, pollMs: 5 } },
        });
        expect(events.at(-1)).toMatchObject({ e: "error", d: { code: "ZAI_TIMEOUT", requestId: expect.any(String) } });
    });

    test("deadline ≥ 3 min and SSE timeout slightly above it", () => {
        expect(Angela.WAIT_TIMEOUT_MS).toBe(200 * 1000);
    });
});

describe("POST /api/zai/callback", () => {
    const seed = async (overrides = {}) => {
        const requestId = crypto.randomUUID();
        await Angela.createRequest({ requestId, zelfName: "miguel.zelf", rulesVersion: "v", cards: [{ type: "doc", title: "t", url: "https://docs.zelf.world/docs/x" }] });
        Object.assign(Store.__store.get(requestId), overrides);
        return requestId;
    };

    test("bad / missing / wrong-secret signature → 401, nothing stored", async () => {
        const id = await seed();
        expect((await postCallback({ requestId: id, text: "x" }, "deadbeef")).status).toBe(401);
        expect((await postCallback({ requestId: id, text: "x" }, "")).status).toBe(401);
        const raw = JSON.stringify({ requestId: id, text: "x" });
        expect((await postCallback({ requestId: id, text: "x" }, sign(raw, "other-secret"))).status).toBe(401);
        expect(Store.__store.get(id).status).toBe("pending");
    });

    test("accepts sha256= prefix; stores redacted text", async () => {
        const id = await seed();
        const body = { requestId: id, text: "key sk-abcdefghijklmnopqrstuv ok" };
        const res = await postCallback(body, `sha256=${sign(JSON.stringify(body))}`);
        expect(res.status).toBe(200);
        expect(Store.__store.get(id)).toMatchObject({ status: "answered", text: "key [redacted] ok" });
    });

    test("duplicate → 409 no-op; late → 410; unknown → 410; bad body → 400", async () => {
        const id = await seed();
        expect((await postCallback({ requestId: id, text: "first" })).status).toBe(200);
        const dup = await postCallback({ requestId: id, text: "second" });
        expect([dup.status, dup.body.code]).toEqual([409, "ZAI_ALREADY_ANSWERED"]);
        expect(Store.__store.get(id).text).toBe("first");
        const late = await seed({ replyDeadline: new Date(Date.now() - 1000) });
        expect((await postCallback({ requestId: late, text: "late" })).body.code).toBe("ZAI_REQUEST_EXPIRED");
        expect(Store.__store.get(late).status).toBe("pending");
        expect((await postCallback({ requestId: crypto.randomUUID(), text: "x" })).status).toBe(410);
        expect((await postCallback({ requestId: "nope", text: "x" })).status).toBe(400);
    });
});

describe("GET /api/zai/result/:requestId (main recovery path)", () => {
    test("same Zelf ID gets text + cards; another Zelf ID gets 404; pending past deadline reads as timeout", async () => {
        const id = crypto.randomUUID();
        await Angela.createRequest({ requestId: id, zelfName: "miguel.zelf", rulesVersion: "v", cards: [{ type: "doc", title: "t", url: "https://docs.zelf.world/docs/x" }] });
        let res = await request(app).get(`/api/zai/result/${id}`).set("Authorization", `Bearer ${token()}`);
        expect(res.body.data).toMatchObject({ status: "pending", text: null, cards: [] });
        await Angela.recordAnswer({ requestId: id, text: "answer" });
        res = await request(app).get(`/api/zai/result/${id}`).set("Authorization", `Bearer ${token()}`);
        expect(res.body.data).toMatchObject({ status: "answered", text: "answer", cards: [{ type: "doc" }] });
        res = await request(app).get(`/api/zai/result/${id}`).set("Authorization", `Bearer ${token("alice.zelf")}`);
        expect([res.status, res.body.code]).toEqual([404, "ZAI_RESULT_NOT_FOUND"]);
        expect((await request(app).get(`/api/zai/result/${id}`)).status).toBe(401);
        expect((await request(app).get(`/api/zai/result/bad`).set("Authorization", `Bearer ${token()}`)).status).toBe(400);
        const old = crypto.randomUUID();
        await Angela.createRequest({ requestId: old, zelfName: "miguel.zelf", rulesVersion: "v", cards: [] });
        Store.__store.get(old).replyDeadline = new Date(Date.now() - 1);
        res = await request(app).get(`/api/zai/result/${old}`).set("Authorization", `Bearer ${token()}`);
        expect(res.body.data.status).toBe("timeout");
    });
});

describe("prefetch plan", () => {
    test("picks tools by question, caps at 5, never takes identity from text", () => {
        expect(Context.plan("What's my ETH balance?").map((c) => c.tool)).toEqual(["get_balances"]);
        expect(Context.plan("How do I recover my Zelf ID?").map((c) => c.tool)).toEqual(["get_account", "search_docs"]);
        const tx = Context.plan(`look up 0x${"cc".repeat(32)} transaction`);
        expect(tx.map((c) => c.tool)).toEqual(["get_transaction"]);
        const all = Context.plan("account balance transactions price referrals how");
        expect(all.length).toBe(5);
        expect(JSON.stringify(Context.plan("balance of alice.zelf"))).not.toMatch(/alice/);
    });
});
