const Koa = require("koa");
const Router = require("@koa/router");
const request = require("supertest");
const koaJwt = require("koa-jwt");
const { accessLog, isAccessLogEnabled, USER_AGENT_LIMIT } = require("../../Core/access-log");

const SECRET = "access-log-test-secret";
const TOKEN_QUERY = "super-secret-token-value";
const AUTH_HEADER = "Bearer eyJhbGciOi-do-not-log";
const COOKIE = "session=do-not-log-cookie";

const captureStdout = () => {
    const chunks = [];
    const spy = jest.spyOn(process.stdout, "write").mockImplementation((chunk, encoding, callback) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
        if (typeof encoding === "function") encoding();
        if (typeof callback === "function") callback();
        return true;
    });

    return {
        spy,
        raw: () => chunks.join(""),
        lines: () =>
            chunks
                .join("")
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line.startsWith("{"))
                .map((line) => JSON.parse(line)),
    };
};

const buildApp = () => {
    const app = new Koa();

    app.use(accessLog());
    app.use(async (ctx, next) => {
        try {
            await next();
        } catch (error) {
            if (error.status === 401) {
                ctx.status = 401;
                ctx.body = { error: "Protected resource, use Authorization header to get access" };
                return;
            }

            throw error;
        }
    });
    app.use(koaJwt({ secret: SECRET }).unless({ path: [/^\/api\/public/] }));

    const router = new Router();

    router.get("/api/public/search", (ctx) => {
        ctx.body = { ok: true };
    });
    router.get("/api/private", (ctx) => {
        ctx.body = { ok: true };
    });
    router.get("/api/public/boom", (ctx) => {
        ctx.throw(418, "nope");
    });

    app.use(router.routes());

    return app;
};

describe("access log", () => {
    const previous = process.env.ACCESS_LOG;

    afterEach(() => {
        jest.restoreAllMocks();
        if (previous === undefined) delete process.env.ACCESS_LOG;
        else process.env.ACCESS_LOG = previous;
    });

    test("is enabled unless ACCESS_LOG=false", () => {
        expect(isAccessLogEnabled({})).toBe(true);
        expect(isAccessLogEnabled({ ACCESS_LOG: "" })).toBe(true);
        expect(isAccessLogEnabled({ ACCESS_LOG: "true" })).toBe(true);
        expect(isAccessLogEnabled({ ACCESS_LOG: "false" })).toBe(false);
        expect(isAccessLogEnabled({ ACCESS_LOG: " FALSE " })).toBe(false);
    });

    test("logs one JSON line and never includes the query string or sensitive headers", async () => {
        delete process.env.ACCESS_LOG;
        const logs = captureStdout();
        const app = buildApp();
        const userAgent = `agent/${"a".repeat(250)}`;

        const response = await request(app.callback())
            .get(`/api/public/search?token=${TOKEN_QUERY}&page=2`)
            .set("X-Forwarded-For", "198.51.100.10, 10.1.1.1")
            .set("X-Real-IP", "192.0.2.5")
            .set("Authorization", AUTH_HEADER)
            .set("Cookie", COOKIE)
            .set("User-Agent", userAgent);

        expect(response.status).toBe(200);

        const raw = logs.raw();
        const [line] = logs.lines();

        expect(logs.lines()).toHaveLength(1);
        expect(line.method).toBe("GET");
        expect(line.path).toBe("/api/public/search");
        expect(line.path.includes("?")).toBe(false);
        expect(line.status).toBe(200);
        expect(line.ip).toBe("198.51.100.10");
        expect(line.userAgent).toHaveLength(USER_AGENT_LIMIT);
        expect(line.userAgent).toBe(userAgent.slice(0, USER_AGENT_LIMIT));
        expect(line.bytes).toBe(Buffer.byteLength(JSON.stringify({ ok: true })));
        expect(line.durationMs).toEqual(expect.any(Number));
        expect(line.durationMs).toBeGreaterThanOrEqual(0);
        expect(line.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
        expect(raw.includes(TOKEN_QUERY)).toBe(false);
        expect(raw.includes("token=")).toBe(false);
        expect(raw.includes("?")).toBe(false);
        expect(raw.includes(AUTH_HEADER)).toBe(false);
        expect(raw.includes("Authorization")).toBe(false);
        expect(raw.includes(COOKIE)).toBe(false);
        expect(raw.includes("Cookie")).toBe(false);
        expect(raw.includes("page=2")).toBe(false);
    });

    test("uses X-Real-IP when X-Forwarded-For is absent", async () => {
        delete process.env.ACCESS_LOG;
        const logs = captureStdout();

        await request(buildApp().callback()).get("/api/public/search").set("X-Real-IP", "192.0.2.8");

        expect(logs.lines()[0].ip).toBe("192.0.2.8");
        expect(logs.lines()[0].path).toBe("/api/public/search");
    });

    test("falls back to the socket address", async () => {
        delete process.env.ACCESS_LOG;
        const logs = captureStdout();

        await request(buildApp().callback()).get("/api/public/search");

        expect(logs.lines()[0].ip).toMatch(/127\.0\.0\.1|::1|::ffff:127\.0\.0\.1/);
    });

    test("logs a 401 from koa-jwt without the query token", async () => {
        delete process.env.ACCESS_LOG;
        const logs = captureStdout();

        const response = await request(buildApp().callback()).get(`/api/private?token=${TOKEN_QUERY}`);

        expect(response.status).toBe(401);
        const [line] = logs.lines();
        expect(line.path).toBe("/api/private");
        expect(line.status).toBe(401);
        expect(logs.raw().includes(TOKEN_QUERY)).toBe(false);
        expect(logs.raw().includes("token=")).toBe(false);
    });

    test("logs an error status and still returns it", async () => {
        delete process.env.ACCESS_LOG;
        const logs = captureStdout();

        const response = await request(buildApp().callback()).get("/api/public/boom?token=another-secret");

        expect(response.status).toBe(418);
        expect(logs.lines()[0].status).toBe(418);
        expect(logs.lines()[0].path).toBe("/api/public/boom");
        expect(logs.raw().includes("another-secret")).toBe(false);
    });

    test("ACCESS_LOG=false writes nothing", async () => {
        process.env.ACCESS_LOG = "false";
        const logs = captureStdout();

        const response = await request(buildApp().callback()).get(`/api/public/search?token=${TOKEN_QUERY}`);

        expect(response.status).toBe(200);
        expect(logs.lines()).toHaveLength(0);
        expect(logs.raw().includes(TOKEN_QUERY)).toBe(false);
        expect(logs.raw().includes("/api/public/search")).toBe(false);
    });
});
