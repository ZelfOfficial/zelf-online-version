jest.mock("../../Repositories/ZAI/models/zai-revoked-token.model", () => {
    const store = new Set();
    return {
        __store: store,
        exists: jest.fn(async (q) => (q.jti.$in.some((j) => store.has(j)) ? { _id: 1 } : null)),
        updateOne: jest.fn(async (q) => {
            store.add(q.jti);
            return { upsertedCount: 1 };
        }),
    };
});

const jwt = require("jsonwebtoken");
const RevokedToken = require("../../Repositories/ZAI/models/zai-revoked-token.model");
const Zai = require("../../Repositories/ZAI/modules/zai-identity.module");
const { zaiTokenValidation: requireZaiToken } = require("../../Repositories/ZAI/middlewares/zai.middleware");

const record = () => ({
    id: "bafyRecord",
    publicData: { tagName: "miguel", domain: "zelf", ethAddress: "0xabc", solanaAddress: "So1", btcAddress: "bc1q", hasPassword: "true" },
    zelfProof: "SECRET_PROOF",
    metadata: { mnemonic: "never in token" },
});

const ctxWith = (token) => ({ headers: token ? { authorization: `Bearer ${token}` } : {}, state: {} });

describe("zAI identity tokens", () => {
    const env = { ...process.env };
    beforeEach(() => {
        RevokedToken.__store.clear();
        process.env.IDENTITY_JWT_SECRET = "identity-test-secret";
        process.env.ZAI_JWT_SECRET = "zai-test-secret";
    });
    afterAll(() => {
        process.env = env;
    });

    test("feature gate: no IDENTITY_JWT_SECRET → decrypt data unchanged, no throw", () => {
        delete process.env.IDENTITY_JWT_SECRET;
        const data = record();
        const before = JSON.stringify(data);
        expect(Zai.attachIdentityToken(data, "zelf")).toBe(data);
        expect(JSON.stringify(data)).toBe(before);
        expect(data.identityToken).toBeUndefined();
    });

    test("attachIdentityToken never throws on odd input", () => {
        expect(Zai.attachIdentityToken(null, "zelf")).toBeNull();
        const noName = { publicData: {} };
        Zai.attachIdentityToken(noName, "zelf");
        expect(noName.identityToken).toBeUndefined();
    });

    test("identity token: claims only from the record, 1h, jti, no secrets", () => {
        const data = Zai.attachIdentityToken(record(), "zelf");
        const claims = jwt.verify(data.identityToken, "identity-test-secret");
        expect(claims).toMatchObject({ typ: "identity", sub: "miguel.zelf", zid: "bafyRecord", addr: { eth: "0xabc", solana: "So1", btc: "bc1q" } });
        expect(claims.exp - claims.iat).toBe(3600);
        expect(claims.jti).toMatch(/[0-9a-f-]{36}/);
        expect(data.identityToken).not.toMatch(/SECRET_PROOF|never in token/);
        expect(JSON.stringify(claims)).not.toMatch(/SECRET_PROOF|mnemonic|hasPassword/);
    });

    test("exchange → zAI token with parent jti, accepted by middleware", async () => {
        const identityToken = Zai.issueIdentityToken(record(), "zelf");
        const { zaiToken, zelfName } = await Zai.exchangeForZaiToken(identityToken);
        expect(zelfName).toBe("miguel.zelf");
        const claims = jwt.verify(zaiToken, "zai-test-secret");
        expect(claims.parent_jti).toBe(jwt.decode(identityToken).jti);
        expect(claims.scope).toEqual(["zai:chat"]);
        expect(claims.exp - claims.iat).toBeLessThanOrEqual(15 * 60);

        const ctx = ctxWith(zaiToken);
        const next = jest.fn();
        await requireZaiToken(ctx, next);
        expect(next).toHaveBeenCalled();
        expect(ctx.state.zai.zelfName).toBe("miguel.zelf");
    });

    test("middleware rejects session JWTs, identity tokens, missing and forged tokens", async () => {
        const sessionJwt = jwt.sign({ tagName: "miguel.zelf", session: "abc" }, "session-secret");
        const cases = [
            [sessionJwt, 403, "ZAI_SCOPE_DENIED"],
            [Zai.issueIdentityToken(record(), "zelf"), 403, "ZAI_SCOPE_DENIED"],
            [null, 401, "ZAI_TOKEN_MISSING"],
            [jwt.sign({ typ: "zai", sub: "x.zelf", scope: ["zai:chat"], jti: "j" }, "wrong"), 401, "ZAI_TOKEN_INVALID"],
            [jwt.sign({ typ: "zai", sub: "x.zelf", scope: ["other"], jti: "j" }, "zai-test-secret"), 403, "ZAI_SCOPE_DENIED"],
            [jwt.sign({ typ: "zai", sub: "x.zelf", scope: ["zai:chat"], jti: "j", exp: 1 }, "zai-test-secret"), 401, "ZAI_TOKEN_EXPIRED"],
        ];
        for (const [token, status, code] of cases) {
            const ctx = ctxWith(token);
            const next = jest.fn();
            await requireZaiToken(ctx, next);
            expect(next).not.toHaveBeenCalled();
            expect([ctx.status, ctx.body.code]).toEqual([status, code]);
        }
    });

    test("session JWT cannot be exchanged", async () => {
        const sessionJwt = jwt.sign({ tagName: "miguel.zelf" }, "session-secret");
        await expect(Zai.exchangeForZaiToken(sessionJwt)).rejects.toMatchObject({ status: 403, code: "ZAI_SCOPE_DENIED" });
    });

    test("revoke identity → exchange and derived zAI tokens refused", async () => {
        const identityToken = Zai.issueIdentityToken(record(), "zelf");
        const { zaiToken } = await Zai.exchangeForZaiToken(identityToken);
        await Zai.revokeIdentityToken(identityToken);
        await Zai.revokeIdentityToken(identityToken); // idempotent
        await expect(Zai.exchangeForZaiToken(identityToken)).rejects.toMatchObject({ code: "ZAI_TOKEN_REVOKED" });
        const ctx = ctxWith(zaiToken);
        await requireZaiToken(ctx, jest.fn());
        expect([ctx.status, ctx.body.code]).toEqual([403, "ZAI_TOKEN_REVOKED"]);
    });

    test("ZAI_JWT_SECRET unset → exchange is ZAI_DISABLED (503), identity still issued", async () => {
        delete process.env.ZAI_JWT_SECRET;
        const identityToken = Zai.issueIdentityToken(record(), "zelf");
        expect(identityToken).toBeTruthy();
        await expect(Zai.exchangeForZaiToken(identityToken)).rejects.toMatchObject({ status: 503, code: "ZAI_DISABLED" });
    });
});

describe("zAI controller/middleware wiring", () => {
    const Controller = require("../../Repositories/ZAI/controllers/zai.controller");
    const Middleware = require("../../Repositories/ZAI/middlewares/zai.middleware");
    beforeEach(() => {
        process.env.IDENTITY_JWT_SECRET = "identity-test-secret";
        process.env.ZAI_JWT_SECRET = "zai-test-secret";
    });

    test("identityTokenValidation: missing → 401 ZAI_TOKEN_MISSING, Bearer is normalised into body", async () => {
        const missing = { headers: {}, request: { body: {} }, state: {} };
        const next = jest.fn();
        await Middleware.identityTokenValidation(missing, next);
        expect(next).not.toHaveBeenCalled();
        expect([missing.status, missing.body.code]).toEqual([401, "ZAI_TOKEN_MISSING"]);

        const viaHeader = { headers: { authorization: "Bearer abc" }, request: { body: {} }, state: {} };
        await Middleware.identityTokenValidation(viaHeader, next);
        expect(next).toHaveBeenCalled();
        expect(viaHeader.request.body.identityToken).toBe("abc");
    });

    test("controller maps module errors to { message, code } with status", async () => {
        const ctx = { request: { body: { identityToken: jwt.sign({ tagName: "x" }, "session-secret") } }, state: {} };
        await Controller.createSession(ctx);
        expect(ctx.status).toBe(403);
        expect(ctx.body).toEqual({ message: "ZAI_SCOPE_DENIED", code: "ZAI_SCOPE_DENIED" });
    });
});
