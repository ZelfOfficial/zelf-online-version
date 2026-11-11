const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const moment = require("moment");
const Koa = require("koa");
const Router = require("@koa/router");
const request = require("supertest");
const koaJwt = require("koa-jwt");
const { MongoMemoryServer } = require("mongodb-memory-server");

const config = require("../../Core/config");
const { signToken, acceptAccessToken, TOKEN_TYPES } = require("../../Core/jwt-claims");
const { verifySuperAdmin } = require("../../Repositories/SuperAdmin/middlewares/verify-super-admin.middleware");
const BlogMiddleware = require("../../Repositories/Blogs/middlewares/blog.middleware");
const SubscriberMiddleware = require("../../Repositories/Subscribers/middlewares/subscriber.middleware");
const SuperAdmin = require("../../Repositories/SuperAdmin/models/super-admin.model");
const SuperAdminModule = require("../../Repositories/SuperAdmin/modules/super-admin.module");
const { assertSuperAdminOtpRateLimit, _resetSuperAdminOtpRateLimit } = require("../../Repositories/SuperAdmin/modules/super-admin-otp-rate-limit.module");

const secret = config.JWT_SECRET || "test-jwt-secret-key-for-testing-only";
if (!config.JWT_SECRET) config.JWT_SECRET = secret;

const buildArticleApp = () => {
    const app = new Koa();
    app.use(async (ctx, next) => {
        try {
            await next();
        } catch (err) {
            if (err.status === 401) {
                ctx.status = 401;
                ctx.body = { error: "Protected resource, use Authorization header to get access" };
                return;
            }
            throw err;
        }
    });
    app.use(koaJwt({ secret: config.JWT_SECRET }));
    app.use(acceptAccessToken);
    const router = new Router();
    require("../../Repositories/Articles/routes/article.route")(router);
    app.use(router.routes());
    return app;
};

describe("token claim separation", () => {
    test("signToken drops caller-controlled privilege claims and sets typ", () => {
        const token = signToken(
            { superAdminId: "forged", staffId: "forged-staff", typ: "super_admin", tagName: "name.zelf", exp: moment().add(5, "minutes").unix() },
            config.JWT_SECRET,
            { typ: TOKEN_TYPES.quote }
        );
        const decoded = jwt.verify(token, config.JWT_SECRET);
        expect(decoded.typ).toBe("quote");
        expect(decoded.tagName).toBe("name.zelf");
        expect(decoded.superAdminId).toBeUndefined();
        expect(decoded.staffId).toBeUndefined();
    });
});

describe("article routes reject session and quote tokens", () => {
    const app = buildArticleApp();

    test("a session token cannot create an article", async () => {
        const token = signToken(
            { identifier: "device", session: new mongoose.Types.ObjectId().toString(), tagName: "reader.zelf" },
            config.JWT_SECRET,
            { typ: TOKEN_TYPES.session, expiresIn: "10m" }
        );
        const response = await request(app.callback()).post("/api/articles").set("Authorization", `Bearer ${token}`).send({
            slug: "hello",
            title: "Hello",
            markdownContent: "body",
        });
        expect(response.status).toBe(403);
        expect(response.body.code).toBe("SUPER_ADMIN_REQUIRED");
    });

    test("a non-expiring session token is rejected", async () => {
        const token = jwt.sign({ identifier: "device", session: "sess" }, config.JWT_SECRET);
        const response = await request(app.callback()).post("/api/articles").set("Authorization", `Bearer ${token}`).send({});
        expect(response.status).toBe(401);
        expect(response.body.code).toBe("INVALID_TOKEN_TYPE");
    });

    test("a quote token cannot create an article", async () => {
        const token = signToken({ tagName: "name.zelf", ttl: moment().add(1, "hour").unix() }, config.JWT_SECRET, {
            typ: TOKEN_TYPES.quote,
            expiresIn: "2h",
        });
        const response = await request(app.callback()).post("/api/articles").set("Authorization", `Bearer ${token}`).send({});
        expect(response.status).toBe(401);
        expect(response.body.code).toBe("INVALID_TOKEN_TYPE");
    });
});

describe("blog and subscriber validation", () => {
    test("blog create rejects unknown keys", async () => {
        const next = jest.fn();
        const ctx = {
            request: {
                body: {
                    slug: "post",
                    title: "Post",
                    markdownContent: "hello",
                    _id: "abc",
                    createdAt: "2020-01-01",
                },
            },
            status: 200,
        };
        await BlogMiddleware.createValidation(ctx, next);
        expect(ctx.status).toBe(409);
        expect(ctx.body.code).toBe("UNKNOWN_FIELD");
        expect(next).not.toHaveBeenCalled();
    });

    test("subscribe rejects a malformed email", async () => {
        const next = jest.fn();
        const ctx = { request: { body: { email: "not-an-email" } }, status: 200 };
        await SubscriberMiddleware.subscribeValidation(ctx, next);
        expect(ctx.status).toBe(409);
        expect(ctx.body.code).toBe("INVALID_EMAIL");
        expect(next).not.toHaveBeenCalled();
    });
});

describe("super-admin OTP rate limit", () => {
    test("the sixth call from one IP is rejected", () => {
        _resetSuperAdminOtpRateLimit();
        for (let i = 0; i < 5; i += 1) {
            expect(() => assertSuperAdminOtpRateLimit("203.0.113.10", "request")).not.toThrow();
        }
        expect(() => assertSuperAdminOtpRateLimit("203.0.113.10", "request")).toThrow(/OTP_RATE_LIMITED/);
        expect(() => assertSuperAdminOtpRateLimit("203.0.113.11", "request")).not.toThrow();
        _resetSuperAdminOtpRateLimit();
    });
});

describe("verifySuperAdmin", () => {
    let memory;

    beforeAll(async () => {
        memory = await MongoMemoryServer.create();
        if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
        await mongoose.connect(memory.getUri());
    });

    afterAll(async () => {
        await mongoose.disconnect();
        if (memory) await memory.stop();
    });

    const createAdmin = async (overrides = {}) =>
        SuperAdmin.create({
            name: "Admin",
            email: `admin-${Date.now()}-${Math.random().toString(16).slice(2)}@zelf.world`,
            phone: `+1${Math.floor(1000000000 + Math.random() * 8999999999)}`,
            active: true,
            status: "joined",
            apiKey: `su_${Math.random().toString(16).slice(2)}`,
            tokenVersion: 0,
            ...overrides,
        });

    const adminToken = (admin, claims = {}) =>
        signToken({ tokenVersion: Number(admin.tokenVersion || 0), exp: moment().add(1, "hour").unix(), ...claims }, config.JWT_SECRET, {
            typ: TOKEN_TYPES.superAdmin,
            superAdminId: String(admin._id),
        });

    const run = async (token) => {
        const next = jest.fn();
        const ctx = { headers: { authorization: `Bearer ${token}` }, state: {}, status: 200 };
        await verifySuperAdmin(ctx, next);
        return { ctx, next };
    };

    test("rejects a session token and a quote token", async () => {
        const session = signToken({ identifier: "device", session: "s1" }, config.JWT_SECRET, { typ: TOKEN_TYPES.session, expiresIn: "10m" });
        const sessionResult = await run(session);
        expect(sessionResult.ctx.status).toBe(403);
        expect(sessionResult.ctx.body.code).toBe("SUPER_ADMIN_REQUIRED");
        expect(sessionResult.next).not.toHaveBeenCalled();

        const quote = signToken({ tagName: "name.zelf" }, config.JWT_SECRET, { typ: TOKEN_TYPES.quote, expiresIn: "2h" });
        const quoteResult = await run(quote);
        expect(quoteResult.ctx.status).toBe(403);
        expect(quoteResult.ctx.body.code).toBe("SUPER_ADMIN_REQUIRED");
        expect(quoteResult.next).not.toHaveBeenCalled();
    });

    test("rejects a disabled admin", async () => {
        const admin = await createAdmin({ disabled: true });
        const { ctx, next } = await run(adminToken(admin));
        expect(ctx.status).toBe(403);
        expect(ctx.body.code).toBe("SUPER_ADMIN_INACTIVE");
        expect(next).not.toHaveBeenCalled();
    });

    test("rejects a token issued before tokensValidAfter", async () => {
        const admin = await createAdmin({ tokensValidAfter: new Date() });
        const issuedAt = Math.floor(Date.now() / 1000) - 120;
        const token = signToken(
            { tokenVersion: 0, iat: issuedAt, exp: issuedAt + 3600 },
            config.JWT_SECRET,
            { typ: TOKEN_TYPES.superAdmin, superAdminId: String(admin._id) }
        );
        const { ctx, next } = await run(token);
        expect(ctx.status).toBe(403);
        expect(ctx.body.code).toBe("TOKEN_REVOKED");
        expect(next).not.toHaveBeenCalled();
    });

    test("accepts a current super-admin token", async () => {
        const admin = await createAdmin();
        const { ctx, next } = await run(adminToken(admin));
        expect(next).toHaveBeenCalledTimes(1);
        expect(ctx.state.user.typ).toBe("super_admin");
        expect(String(ctx.state.user.superAdminId)).toBe(String(admin._id));
    });

    test("five wrong OTP codes invalidate the code", async () => {
        const admin = await createAdmin();
        admin.otp = "123456";
        admin.otpExpiration = moment().add(10, "minutes").toDate();
        admin.otpAttempts = 0;
        await admin.save();

        for (let attempt = 1; attempt <= 4; attempt += 1) {
            await expect(SuperAdminModule.verifyOtp({ email: admin.email, code: "000000" })).rejects.toMatchObject({
                code: "INVALID_EMAIL_OR_CODE",
            });
        }

        await expect(SuperAdminModule.verifyOtp({ email: admin.email, code: "000000" })).rejects.toMatchObject({
            code: "OTP_ATTEMPTS_EXCEEDED",
        });

        const stored = await SuperAdmin.findById(admin._id);
        expect(stored.otp).toBeFalsy();
        expect(stored.otpExpiration).toBeFalsy();
    });
});
