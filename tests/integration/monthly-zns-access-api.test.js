/**
 * HTTP contract for monthly ZNS access: Joi validation, owner check, signed quote, and pay errors.
 * The rule matrix (grace, parallel debit, plan exemption) lives in tests/unit/monthly-zns-access.test.js.
 * Tag lookup is stubbed the same way the my-plan tests stub search. Charges use the real module and MongoDB.
 */
process.env.CONNECTION_KEY = process.env.CONNECTION_KEY || "monthly-access-test-key";

jest.mock("../../Repositories/Wallet/modules/wallet.module", () => ({
    decryptWallet: jest.fn(),
}));

const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");
const Koa = require("koa");
const Router = require("koa-router");
const bodyParser = require("koa-bodyparser");

const config = require("../../Core/config");
const { zelfPlanLicense, useZelfPlanLicense } = require("../fixtures/zelf-plan-license.fixture");
const { describeAmount } = require("../../Repositories/ZelfID/modules/zelf-id-monthly-access.module");
const MonthlyAccessController = require("../../Repositories/ZelfID/controllers/zelf-id-monthly-access.controller");
const MonthlyAccessMiddleware = require("../../Repositories/ZelfID/middlewares/zelf-id-monthly-access.middleware");
const MonthlyAccess = require("../../Repositories/ZelfID/models/zelf-id-monthly-access.model");
const MonthlyAccessAudit = require("../../Repositories/ZelfID/models/zelf-id-monthly-access-audit.model");
const SlotAccount = require("../../Repositories/ZelfKeys/models/zelf-key-slot-account.model");
const TagsSearch = require("../../Repositories/Tags/modules/tags-search.module");
const WalletModule = require("../../Repositories/Wallet/modules/wallet.module");
const WalletController = require("../../Repositories/Wallet/controllers/wallet.controller");
const WalletMiddleware = require("../../Repositories/Wallet/middlewares/wallet.middleware");
const { applyOperation } = require("../../Repositories/ZelfID/modules/zelf-id-monthly-access.module");

const domainConfig = zelfPlanLicense();

describe("monthly ZNS access API", () => {
    let memory;
    let app;
    const previousFlag = process.env.MONTHLY_ZNS_ACCESS_ENABLED;
    const owner = { tagName: "myname", domain: "zelf" };

    beforeAll(async () => {
        process.env.MONTHLY_ZNS_ACCESS_ENABLED = "true";
        memory = await MongoMemoryServer.create();
        if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
        await mongoose.connect(memory.getUri());
        await MonthlyAccess.init();

        const router = new Router();
        const base = config.basePath("/zelf-ids");
        router.get(`${base}/monthly-access`, MonthlyAccessMiddleware.statusValidation, MonthlyAccessController.status);
        router.get(`${base}/monthly-access/quote`, MonthlyAccessMiddleware.quoteValidation, MonthlyAccessController.quote);
        router.post(`${base}/monthly-access/confirm`, MonthlyAccessMiddleware.confirmValidation, MonthlyAccessController.confirm);

        app = new Koa();
        app.use(bodyParser());
        app.use(async (ctx, next) => {
            if (ctx.headers["x-test-user"]) ctx.state.user = JSON.parse(ctx.headers["x-test-user"]);
            await next();
        });
        app.use(router.routes());
        app.use(router.allowedMethods());
    }, 180000);

    afterAll(async () => {
        if (previousFlag === undefined) delete process.env.MONTHLY_ZNS_ACCESS_ENABLED;
        else process.env.MONTHLY_ZNS_ACCESS_ENABLED = previousFlag;
        await mongoose.disconnect();
        if (memory) await memory.stop();
    });

    beforeEach(async () => {
        process.env.MONTHLY_ZNS_ACCESS_ENABLED = "true";
        useZelfPlanLicense();
        jest.spyOn(TagsSearch, "searchTag").mockResolvedValue({
            available: false,
            tagObject: {
                publicData: {
                    plan: "free",
                    type: "mainnet",
                    tagName: "myname.zelf",
                    zelfName: "myname.zelf",
                    expiresAt: "2126-01-01 00:00:00",
                },
            },
        });
        await MonthlyAccess.deleteMany({});
        await MonthlyAccessAudit.deleteMany({});
        await SlotAccount.deleteMany({});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test("routes register quote, confirm, and wallet export", () => {
        const root = path.join(__dirname, "../..");
        const zelfIds = fs.readFileSync(path.join(root, "Repositories/ZelfID/routes/zelf-ids.routes.js"), "utf8");
        const wallets = fs.readFileSync(path.join(root, "Repositories/Wallet/routes/wallet.route.js"), "utf8");
        expect(zelfIds).toContain("/monthly-access");
        expect(zelfIds).toContain("/monthly-access/quote");
        expect(zelfIds).toContain("/monthly-access/confirm");
        expect(wallets).toContain("/export");
        expect(wallets).toContain("wallet-export");
        expect(wallets).toContain("wallet-decrypt");
    });

    test("quote, expired confirm, card stub, and short balance", async () => {
        const missing = await request(app.callback()).get("/api/zelf-ids/monthly-access/quote");
        expect(missing.status).toBe(409);

        const anonymous = await request(app.callback()).get("/api/zelf-ids/monthly-access").query({ tagName: "myname", domain: "zelf" });
        expect(anonymous.status).toBe(401);

        const other = await request(app.callback())
            .get("/api/zelf-ids/monthly-access")
            .set("x-test-user", JSON.stringify(owner))
            .query({ tagName: "other", domain: "zelf" });
        expect(other.status).toBe(403);

        const quoted = await request(app.callback())
            .get("/api/zelf-ids/monthly-access/quote")
            .set("x-test-user", JSON.stringify(owner))
            .query({ tagName: "myname", domain: "zelf" });
        expect(quoted.status).toBe(200);
        expect(quoted.body.data.amountZns).toBe(describeAmount({ tagName: "myname.zelf", domainConfig }).amountZns);
        expect(quoted.body.data.signedDataPrice).toEqual(expect.any(String));
        expect(quoted.body.data.periodKey).toEqual(expect.stringMatching(/^\d{4}-\d{2}$/));
        expect(await MonthlyAccess.countDocuments()).toBe(0);

        const decoded = jwt.verify(quoted.body.data.signedDataPrice, config.JWT_SECRET);
        decoded.ttl = 1;
        const expired = await request(app.callback())
            .post("/api/zelf-ids/monthly-access/confirm")
            .set("x-test-user", JSON.stringify(owner))
            .send({ token: jwt.sign(decoded, config.JWT_SECRET) });
        expect(expired.status).toBe(409);
        expect(expired.body.code).toBe("MONTHLY_ACCESS_QUOTE_EXPIRED");

        const card = await request(app.callback())
            .post("/api/zelf-ids/monthly-access/confirm")
            .set("x-test-user", JSON.stringify(owner))
            .send({ token: quoted.body.data.signedDataPrice, method: "card" });
        expect(card.status).toBe(409);
        expect(card.body.code).toBe("MONTHLY_ACCESS_CARD_UNAVAILABLE");

        const short = await request(app.callback())
            .post("/api/zelf-ids/monthly-access/confirm")
            .set("x-test-user", JSON.stringify(owner))
            .send({ token: quoted.body.data.signedDataPrice, method: "zns" });
        expect(short.status).toBe(402);
        expect(short.body.code).toBe("MONTHLY_ACCESS_PAYMENT_REQUIRED");
        expect(short.body.amountZns).toBe(quoted.body.data.amountZns);
        expect(short.body.amountUsd).toBe(quoted.body.data.amountUsd);
        expect(short.body.znsNeeded).toBe(quoted.body.data.amountZns);
        expect(short.body.options.map((option) => option.type)).toEqual(["upgrade", "card", "zns"]);

        const status = await request(app.callback())
            .get("/api/zelf-ids/monthly-access")
            .set("x-test-user", JSON.stringify(owner))
            .query({ tagName: "myname", domain: "zelf" });
        expect(status.status).toBe(200);
        expect(status.body.data.status).toBe("none");
        expect(status.body.data.openAllowed).toBe(true);
        expect(status.body.data.amountZns).toBe(quoted.body.data.amountZns);
    });
});

describe("wallet export during an unpaid grace month", () => {
    let memory;
    let app;
    const previousFlag = process.env.MONTHLY_ZNS_ACCESS_ENABLED;

    beforeAll(async () => {
        process.env.MONTHLY_ZNS_ACCESS_ENABLED = "true";
        memory = await MongoMemoryServer.create();
        if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
        await mongoose.connect(memory.getUri());
        await MonthlyAccess.init();

        const router = new Router();
        const base = config.basePath("/my-wallets");
        router.post(`${base}/export`, WalletMiddleware.exportWalletValidation, WalletController.exportWallet);

        app = new Koa();
        app.use(bodyParser());
        app.use(async (ctx, next) => {
            if (ctx.headers["x-test-user"]) ctx.state.user = JSON.parse(ctx.headers["x-test-user"]);
            await next();
        });
        app.use(router.routes());
        app.use(router.allowedMethods());
    }, 180000);

    afterAll(async () => {
        if (previousFlag === undefined) delete process.env.MONTHLY_ZNS_ACCESS_ENABLED;
        else process.env.MONTHLY_ZNS_ACCESS_ENABLED = previousFlag;
        await mongoose.disconnect();
        if (memory) await memory.stop();
    });

    beforeEach(async () => {
        process.env.MONTHLY_ZNS_ACCESS_ENABLED = "true";
        useZelfPlanLicense();
        WalletModule.decryptWallet.mockReset();
        WalletModule.decryptWallet.mockResolvedValue({ publicData: { zelfName: "blocked.zelf" } });
        await MonthlyAccess.deleteMany({});
        await SlotAccount.deleteMany({});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test("a session JWT can export while the Free month is grace", async () => {
        await applyOperation({
            trigger: "retrieve",
            zelfName: "blocked.zelf",
            domain: "zelf",
            plan: "free",
            publicData: {
                plan: "free",
                type: "mainnet",
                tagName: "blocked.zelf",
                zelfName: "blocked.zelf",
                expiresAt: "2126-01-01 00:00:00",
            },
            domainConfig,
            balance: 0,
            tokenPriceUsd: 0.05,
            floorUsd: 0.1,
            skipSubscriptionLookup: true,
            now: new Date("2026-10-15T12:00:00.000Z"),
        });
        expect(await MonthlyAccess.countDocuments({ zelfName: "blocked.zelf", status: "grace" })).toBe(1);

        const anonymous = await request(app.callback()).post("/api/my-wallets/export").send({ faceBase64: "face", zelfProof: "proof" });
        expect(anonymous.status).toBe(409);

        const exported = await request(app.callback())
            .post("/api/my-wallets/export")
            .set("x-test-user", JSON.stringify({ session: "sess-1", tagName: "blocked", domain: "zelf" }))
            .send({ faceBase64: "face", zelfProof: "proof" });

        expect(exported.status).toBe(200);
        expect(exported.body.data.publicData.zelfName).toBe("blocked.zelf");
        expect(WalletModule.decryptWallet).toHaveBeenCalled();
        expect(await MonthlyAccess.findOne({ zelfName: "blocked.zelf" }).lean()).toMatchObject({ status: "grace" });
        expect(await SlotAccount.countDocuments({ zelfName: "blocked.zelf" })).toBe(0);
    });
});
