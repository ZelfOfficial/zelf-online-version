// stellar-hd-wallet is ESM and cannot load under Jest; the controllers only need it at runtime.
jest.mock("../../Repositories/Wallet/modules/stellar", () => ({ createStellarWallet: jest.fn(), healPublicDataXlm: jest.fn() }));

const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const moment = require("moment");
const Koa = require("koa");
const Router = require("@koa/router");
const request = require("supertest");
const koaJwt = require("koa-jwt");
const { MongoMemoryServer } = require("mongodb-memory-server");

const config = require("../../Core/config");
const { createBodyParser } = require("../../Core/request-body");
const { signToken, acceptAccessToken, TOKEN_TYPES, SUPER_ADMIN_ROLES } = require("../../Core/jwt-claims");
const { verifySuperAdmin, verifyBlogSuperAdmin } = require("../../Repositories/SuperAdmin/middlewares/verify-super-admin.middleware");
const BlogMiddleware = require("../../Repositories/Blogs/middlewares/blog.middleware");
const BlogModel = require("../../Repositories/Blogs/models/blog.model");
const SubscriberMiddleware = require("../../Repositories/Subscribers/middlewares/subscriber.middleware");
const SuperAdmin = require("../../Repositories/SuperAdmin/models/super-admin.model");
const SuperAdminModule = require("../../Repositories/SuperAdmin/modules/super-admin.module");
const ClientMiddleware = require("../../Repositories/Client/middlewares/client.middleware");
const ClientModule = require("../../Repositories/Client/modules/client.module");
const StaffModule = require("../../Repositories/Staff/modules/staff.module");
const LawyerModule = require("../../Repositories/Lawyer/modules/lawyer.module");
const WalletMiddleware = require("../../Repositories/Wallet/middlewares/wallet.middleware");
const WalletModule = require("../../Repositories/Wallet/modules/wallet.module");
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

    describe("blog-role super-admin restrictions", () => {
        const buildProtectedTestApp = () => {
            const app = new Koa();
            app.use(createBodyParser());
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

            // Unprotected routes (e.g. /api/super-admins, /api/clients, public /api/blogs)
            const unprotectedRouter = new Router();
            require("../../Repositories/SuperAdmin/routes/super-admin.route")(unprotectedRouter);
            require("../../Repositories/Client/routes/unprotected-client.route")(unprotectedRouter);
            require("../../Repositories/Blogs/routes/blog-public.routes")(unprotectedRouter);
            app.use(unprotectedRouter.routes());

            // JWT + acceptAccessToken gate (same order as server.js)
            app.use(koaJwt({ secret: config.JWT_SECRET }));
            app.use(acceptAccessToken);

            const protectedRouter = new Router();
            require("../../Repositories/Blogs/routes/blog-protected.routes")(protectedRouter);
            require("../../Repositories/Articles/routes/article.route")(protectedRouter);
            require("../../Repositories/ZelfID/routes/zelf-ids-coupons.routes")(protectedRouter);
            require("../../Repositories/Tags/routes/tags.routes")(protectedRouter);
            require("../../Repositories/ZelfNameService/routes/zns.routes")(protectedRouter);
            require("../../Repositories/IPFS/routes/ipfs.routes")(protectedRouter);
            require("../../Repositories/Client/routes/client.route")(protectedRouter);
            require("../../Repositories/Staff/routes/staff.route")(protectedRouter);
            require("../../Repositories/Lawyer/routes/lawyer.routes")(protectedRouter);
            require("../../Repositories/Wallet/routes/wallet.route")(protectedRouter);
            app.use(protectedRouter.routes());
            return app;
        };

        test("a blog-role super-admin can create, update, and delete blogs", async () => {
            const app = buildProtectedTestApp();
            const blogAdmin = await createAdmin({ role: SUPER_ADMIN_ROLES.blog });
            const token = SuperAdminModule.signSuperAdminToken(blogAdmin);

            const decoded = jwt.verify(token, config.JWT_SECRET);
            expect(decoded.role).toBe("blog");

            const slug = `security-test-post-${Date.now()}`;
            const createRes = await request(app.callback())
                .post("/api/blogs")
                .set("Authorization", `Bearer ${token}`)
                .send({
                    slug,
                    title: "Security Hardening Post",
                    description: "Testing blog role permissions",
                    markdownContent: "# Hello World",
                    locale: "en",
                    published: false,
                });

            expect(createRes.status).toBe(200);
            expect(createRes.body.data).toBeDefined();
            expect(createRes.body.data.slug).toBe(slug);
            const blogId = createRes.body.data._id;

            const updateRes = await request(app.callback())
                .put(`/api/blogs/${blogId}`)
                .set("Authorization", `Bearer ${token}`)
                .send({
                    title: "Updated Security Hardening Post",
                });

            expect(updateRes.status).toBe(200);
            expect(updateRes.body.data.title).toBe("Updated Security Hardening Post");

            const deleteRes = await request(app.callback())
                .delete(`/api/blogs/${blogId}`)
                .set("Authorization", `Bearer ${token}`);

            expect(deleteRes.status).toBe(200);
            expect(await BlogModel.findById(blogId)).toBeNull();
        });

        test("a blog-role super-admin is blocked from all non-blog super-admin and protected routes", async () => {
            const app = buildProtectedTestApp();
            const blogAdmin = await createAdmin({ role: SUPER_ADMIN_ROLES.blog });
            const token = SuperAdminModule.signSuperAdminToken(blogAdmin);

            // Cannot create or send articles
            const articleRes = await request(app.callback())
                .post("/api/articles")
                .set("Authorization", `Bearer ${token}`)
                .send({ slug: "blocked-article", title: "Blocked", markdownContent: "No" });
            expect(articleRes.status).toBe(403);
            expect(articleRes.body.code).toBe("SUPER_ADMIN_ROLE_FORBIDDEN");

            const sendAllRes = await request(app.callback())
                .post("/api/articles/blocked-article/send-all")
                .set("Authorization", `Bearer ${token}`)
                .send({});
            expect(sendAllRes.status).toBe(403);
            expect(sendAllRes.body.code).toBe("SUPER_ADMIN_ROLE_FORBIDDEN");

            // Cannot list, create, or deactivate Zelf ID coupons
            const couponListRes = await request(app.callback())
                .get("/api/zelf-ids/coupons")
                .set("Authorization", `Bearer ${token}`);
            expect(couponListRes.status).toBe(403);
            expect(couponListRes.body.code).toBe("SUPER_ADMIN_ROLE_FORBIDDEN");

            const couponCreateRes = await request(app.callback())
                .post("/api/zelf-ids/coupons")
                .set("Authorization", `Bearer ${token}`)
                .send({ code: "HACK100", percentOff: 100, plans: ["premium"], maxRedemptions: 10 });
            expect(couponCreateRes.status).toBe(403);
            expect(couponCreateRes.body.code).toBe("SUPER_ADMIN_ROLE_FORBIDDEN");

            // Cannot trigger referral or purchase rewards
            const tagRewardRes = await request(app.callback())
                .post("/api/tags/referral-rewards")
                .set("Authorization", `Bearer ${token}`)
                .send({});
            expect(tagRewardRes.status).toBe(403);
            expect(tagRewardRes.body.code).toBe("SUPER_ADMIN_ROLE_FORBIDDEN");

            const znsRewardRes = await request(app.callback())
                .post("/api/zelf-name-service/referral-rewards")
                .set("Authorization", `Bearer ${token}`)
                .send({});
            expect(znsRewardRes.status).toBe(403);
            expect(znsRewardRes.body.code).toBe("SUPER_ADMIN_ROLE_FORBIDDEN");

            // Cannot query /api/ipfs, /api/staff, /api/lawyers, /api/my-wallets, /api/clients/sync
            for (const path of ["/api/ipfs", "/api/staff", "/api/lawyers", "/api/lawyers/all", "/api/lawyers/invitations", "/api/my-wallets"]) {
                const res = await request(app.callback()).get(path).set("Authorization", `Bearer ${token}`);
                expect(res.status).toBe(403);
                expect(res.body.code).toBe("SUPER_ADMIN_ROLE_FORBIDDEN");
            }

            // Cannot list or create super-admins
            const listAdminsRes = await request(app.callback())
                .get("/api/super-admins")
                .set("Authorization", `Bearer ${token}`);
            expect(listAdminsRes.status).toBe(403);

            // Cannot list all clients
            const listClientsRes = await request(app.callback())
                .get("/api/clients")
                .set("Authorization", `Bearer ${token}`);
            expect(listClientsRes.status).toBe(400);
            expect(listClientsRes.body.code).toBe("CLIENT_IDENTIFIER_REQUIRED");
        });

        test("downgrading an admin in MongoDB to role=blog immediately blocks an already-issued super_admin token on non-blog routes", async () => {
            const admin = await createAdmin({ role: SUPER_ADMIN_ROLES.superAdmin });
            const legacyFullToken = adminToken(admin); // signed before role downgrade

            await SuperAdmin.findByIdAndUpdate(admin._id, { role: SUPER_ADMIN_ROLES.blog });

            const nonBlogNext = jest.fn();
            const nonBlogCtx = { headers: { authorization: `Bearer ${legacyFullToken}` }, state: {}, status: 200 };
            await verifySuperAdmin(nonBlogCtx, nonBlogNext);
            expect(nonBlogCtx.status).toBe(403);
            expect(nonBlogCtx.body.code).toBe("SUPER_ADMIN_ROLE_FORBIDDEN");
            expect(nonBlogNext).not.toHaveBeenCalled();

            const blogNext = jest.fn();
            const blogCtx = { headers: { authorization: `Bearer ${legacyFullToken}` }, state: {}, status: 200 };
            await verifyBlogSuperAdmin(blogCtx, blogNext);
            expect(blogNext).toHaveBeenCalledTimes(1);
            expect(blogCtx.state.user.role).toBe("blog");
        });

        test("verifyOtp with role=blog issues a blog-only token even for a full super_admin account", async () => {
            const admin = await createAdmin({ role: SUPER_ADMIN_ROLES.superAdmin });
            admin.otp = "654321";
            admin.otpExpiration = moment().add(10, "minutes").toDate();
            admin.otpAttempts = 0;
            await admin.save();

            const result = await SuperAdminModule.verifyOtp({
                email: admin.email,
                code: "654321",
                role: "blog",
            });

            expect(result.role).toBe("blog");
            const decoded = jwt.verify(result.token, config.JWT_SECRET);
            expect(decoded.role).toBe("blog");

            // Cannot pass verifySuperAdmin (non-blog routes)
            const nonBlogNext = jest.fn();
            const nonBlogCtx = { headers: { authorization: `Bearer ${result.token}` }, state: {}, status: 200 };
            await verifySuperAdmin(nonBlogCtx, nonBlogNext);
            expect(nonBlogCtx.status).toBe(403);
            expect(nonBlogCtx.body.code).toBe("SUPER_ADMIN_ROLE_FORBIDDEN");
            expect(nonBlogNext).not.toHaveBeenCalled();

            // Can pass verifyBlogSuperAdmin (blog routes)
            const blogNext = jest.fn();
            const blogCtx = { headers: { authorization: `Bearer ${result.token}` }, state: {}, status: 200 };
            await verifyBlogSuperAdmin(blogCtx, blogNext);
            expect(blogNext).toHaveBeenCalledTimes(1);
        });
    });

    describe("normal wallet session tokens cannot access admin, client, staff, lawyer, or wallet lists", () => {
        const mintSessionToken = (claims = {}) =>
            signToken(
                {
                    identifier: "wallet-device-1",
                    session: new mongoose.Types.ObjectId().toString(),
                    tagName: "user.zelf",
                    ...claims,
                },
                config.JWT_SECRET,
                { typ: TOKEN_TYPES.session, expiresIn: "30m" }
            );

        test("session token cannot list, view, create, or delete super-admins", async () => {
            const app = new Koa();
            app.use(createBodyParser());
            const router = new Router();
            require("../../Repositories/SuperAdmin/routes/super-admin.route")(router);
            app.use(router.routes());

            const sessionToken = mintSessionToken();

            const listRes = await request(app.callback())
                .get("/api/super-admins")
                .set("Authorization", `Bearer ${sessionToken}`);
            expect(listRes.status).toBe(403);
            expect(listRes.body.code).toBe("SUPER_ADMIN_SECRET_REQUIRED");

            const showRes = await request(app.callback())
                .get(`/api/super-admins/${new mongoose.Types.ObjectId().toString()}`)
                .set("Authorization", `Bearer ${sessionToken}`);
            expect(showRes.status).toBe(403);
            expect(showRes.body.code).toBe("SUPER_ADMIN_SECRET_REQUIRED");

            const createRes = await request(app.callback())
                .post("/api/super-admins")
                .set("Authorization", `Bearer ${sessionToken}`)
                .send({
                    name: "Attacker",
                    countryCode: "+1",
                    phone: "5551234567",
                    email: "attacker@example.com",
                });
            expect(createRes.status).toBe(403);
            expect(createRes.body.code).toBe("SUPER_ADMIN_SECRET_REQUIRED");

            const deleteRes = await request(app.callback())
                .delete(`/api/super-admins/${new mongoose.Types.ObjectId().toString()}`)
                .set("Authorization", `Bearer ${sessionToken}`);
            expect(deleteRes.status).toBe(403);
            expect(deleteRes.body.code).toBe("SUPER_ADMIN_SECRET_REQUIRED");
        });

        test("session token cannot list all clients or mutate client accounts", async () => {
            const sessionToken = mintSessionToken();
            const app = new Koa();
            app.use(createBodyParser());
            const unprotectedRouter = new Router();
            require("../../Repositories/Client/routes/unprotected-client.route")(unprotectedRouter);
            app.use(unprotectedRouter.routes());
            app.use(koaJwt({ secret: config.JWT_SECRET }));
            app.use(acceptAccessToken);
            const protectedRouter = new Router();
            require("../../Repositories/Client/routes/client.route")(protectedRouter);
            app.use(protectedRouter.routes());

            // Unfiltered GET /api/clients is rejected (400)
            const listRes = await request(app.callback())
                .get("/api/clients")
                .set("Authorization", `Bearer ${sessionToken}`);
            expect(listRes.status).toBe(400);
            expect(listRes.body.code).toBe("CLIENT_IDENTIFIER_REQUIRED");

            // Module methods never return a list when email/phone are omitted
            expect(await ClientModule.get({})).toBeNull();
            expect(await ClientModule.show({})).toBeNull();

            // Mutating client endpoints reject session tokens (403)
            const syncRes = await request(app.callback())
                .put("/api/clients/sync")
                .set("Authorization", `Bearer ${sessionToken}`)
                .send({ faceBase64: "abc", masterPassword: "pass" });
            expect(syncRes.status).toBe(403);
            expect(syncRes.body.code).toBe("CLIENT_AUTH_REQUIRED");

            const deleteRes = await request(app.callback())
                .delete("/api/clients")
                .set("Authorization", `Bearer ${sessionToken}`)
                .send({});
            expect(deleteRes.status).toBe(403);
            expect(deleteRes.body.code).toBe("CLIENT_AUTH_REQUIRED");
        });

        test("session token cannot list staff, lawyers, lawyer invitations, or wallets", async () => {
            const sessionUser = {
                identifier: "wallet-device-1",
                session: new mongoose.Types.ObjectId().toString(),
                tagName: "user.zelf",
                typ: TOKEN_TYPES.session,
                exp: moment().add(30, "minutes").unix(),
            };

            await expect(StaffModule.get({}, sessionUser)).rejects.toMatchObject({
                status: 403,
                code: "FORBIDDEN",
            });

            await expect(LawyerModule.get({}, sessionUser)).rejects.toMatchObject({
                status: 403,
                code: "FORBIDDEN",
            });

            await expect(LawyerModule.getAll({}, sessionUser)).rejects.toMatchObject({
                status: 403,
                code: "FORBIDDEN",
            });

            await expect(LawyerModule.getInvitations({}, sessionUser)).rejects.toMatchObject({
                status: 403,
                code: "FORBIDDEN",
            });

            const walletNext = jest.fn();
            const walletCtx = { state: { user: sessionUser }, status: 200 };
            await WalletMiddleware.getValidation(walletCtx, walletNext);
            expect(walletCtx.status).toBe(403);
            expect(walletCtx.body.code).toBe("FORBIDDEN");
            expect(walletNext).not.toHaveBeenCalled();

            await expect(WalletModule.get({}, sessionUser)).rejects.toMatchObject({
                status: 403,
                code: "FORBIDDEN",
            });
        });

        test("session token cannot create, update, or delete blogs", async () => {
            const app = new Koa();
            app.use(createBodyParser());
            app.use(koaJwt({ secret: config.JWT_SECRET }));
            app.use(acceptAccessToken);
            const router = new Router();
            require("../../Repositories/Blogs/routes/blog-protected.routes")(router);
            app.use(router.routes());

            const sessionToken = mintSessionToken();

            const createRes = await request(app.callback())
                .post("/api/blogs")
                .set("Authorization", `Bearer ${sessionToken}`)
                .send({ slug: "hack", title: "Hack", markdownContent: "No" });
            expect(createRes.status).toBe(403);
            expect(createRes.body.code).toBe("SUPER_ADMIN_REQUIRED");

            const updateRes = await request(app.callback())
                .put(`/api/blogs/${new mongoose.Types.ObjectId().toString()}`)
                .set("Authorization", `Bearer ${sessionToken}`)
                .send({ title: "Hack" });
            expect(updateRes.status).toBe(403);
            expect(updateRes.body.code).toBe("SUPER_ADMIN_REQUIRED");

            const deleteRes = await request(app.callback())
                .delete(`/api/blogs/${new mongoose.Types.ObjectId().toString()}`)
                .set("Authorization", `Bearer ${sessionToken}`);
            expect(deleteRes.status).toBe(403);
            expect(deleteRes.body.code).toBe("SUPER_ADMIN_REQUIRED");
        });
    });
});
