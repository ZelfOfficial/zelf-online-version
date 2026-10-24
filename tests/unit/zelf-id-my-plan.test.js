/**
 * GET /api/zelf-ids/my-plan: verified owner, and an upgrade link per payment method.
 */
const moment = require("moment");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { Domain } = require("../../Repositories/Tags/modules/domain.class");
const { zelfPlanLicenseData } = require("../fixtures/zelf-plan-license.fixture");

jest.mock("../../Repositories/Tags/config/supported-domains", () => ({
    getDomainConfig: () => domainConfig,
}));

jest.mock("../../Repositories/ZelfID/modules/zelf-id.module", () => ({
    searchTag: jest.fn(),
}));

const config = require("../../Core/config");
const Session = require("../../Repositories/Session/models/session.model");
const { myPlanValidation } = require("../../Repositories/ZelfID/middlewares/zelf-ids-my-plan.middleware");
const { buildMyPlan, getMyPlan } = require("../../Repositories/ZelfID/modules/zelf-ids-my-plan.module");
const ZelfIdModule = require("../../Repositories/ZelfID/modules/zelf-id.module");

let domainConfig;

const license = () =>
    new Domain({
        ...zelfPlanLicenseData(),
        tags: {
            ...zelfPlanLicenseData().tags,
            minLength: 1,
            storage: { keyPrefix: "tagName", ipfsEnabled: false, arweaveEnabled: false },
        },
    });

const lease = (extra = {}) => ({
    publicData: {
        tagName: "myname.zelf",
        type: "mainnet",
        plan: "premium",
        duration: "1",
        expiresAt: "2027-10-24 18:00:00",
        paymentMethod: "coupon",
        ...extra,
    },
});

const openSession = async (fields) =>
    Session.create({
        identifier: `sess-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        clientIP: "127.0.0.1",
        domain: "zelf",
        isWebExtension: false,
        status: "active",
        type: "decryptWallet",
        ...fields,
    });

describe("Zelf ID my-plan", () => {
    let memory;

    beforeAll(async () => {
        domainConfig = license();
        config.landingUrl = "https://zelf.world";
        memory = await MongoMemoryServer.create();
        await mongoose.connect(memory.getUri());
    }, 180000);

    afterAll(async () => {
        await mongoose.disconnect();
        if (memory) await memory.stop();
    });

    beforeEach(async () => {
        await Session.deleteMany({});
        ZelfIdModule.searchTag.mockReset();
    });

    test("verified owner receives the plan and a checkout link for coupon, stripe, crypto, and free", async () => {
        const coupon = await buildMyPlan(lease({ paymentMethod: "coupon", plan: "premium" }), {
            zelfName: "myname.zelf",
            domainConfig,
        });
        expect(coupon).toMatchObject({
            zelfName: "myname.zelf",
            plan: "premium",
            duration: "1y",
            paymentMethod: "coupon",
            nextPlans: ["unlimited"],
            upgrade: { action: "checkout" },
        });
        expect(coupon.expiresAt).toBe("2027-10-24T18:00:00.000Z");
        const checkout = new URL(coupon.upgrade.url);
        expect(checkout.origin + checkout.pathname).toBe("https://zelf.world/pricing");
        expect(checkout.searchParams.get("tagname")).toBe("myname");
        expect(checkout.searchParams.get("domain")).toBe("zelf");
        expect(checkout.searchParams.get("plan")).toBe("unlimited");
        expect(checkout.searchParams.get("zelfName")).toBe("myname.zelf");

        const stripe = await buildMyPlan(lease({ paymentMethod: "stripe" }), { zelfName: "myname.zelf", domainConfig });
        expect(stripe.paymentMethod).toBe("stripe");
        expect(stripe.upgrade.action).toBe("checkout");

        const crypto = await buildMyPlan(lease({ paymentMethod: "ETH" }), { zelfName: "myname.zelf", domainConfig });
        expect(crypto.paymentMethod).toBe("crypto");
        expect(crypto.upgrade.action).toBe("checkout");

        const free = await buildMyPlan(lease({ plan: "free", duration: "1", paymentMethod: undefined }), {
            zelfName: "myname.zelf",
            domainConfig,
        });
        expect(free.paymentMethod).toBe("free");
        expect(free.nextPlans).toEqual(["premium", "unlimited"]);
        expect(free.upgrade.action).toBe("checkout");
        expect(new URL(free.upgrade.url).searchParams.get("plan")).toBe("premium");

        const whitelist = await buildMyPlan(lease({ paymentMethod: "whitelist", plan: "premium", duration: "1" }), {
            zelfName: "myname.zelf",
            domainConfig,
        });
        expect(whitelist.paymentMethod).toBe("whitelist");
        expect(whitelist.duration).toBe("1y");
        expect(whitelist.upgrade.action).toBe("checkout");
    });

    test("upgrade URL stays on zelf.world unless LANDING_URL is set", async () => {
        const previous = process.env.LANDING_URL;
        delete process.env.LANDING_URL;
        config.landingUrl = "http://localhost:3009";
        const plain = await buildMyPlan(lease({ paymentMethod: "coupon" }), { zelfName: "myname.zelf", domainConfig });
        expect(plain.upgrade.url.startsWith("https://zelf.world/pricing?")).toBe(true);

        process.env.LANDING_URL = "https://preview.example";
        const custom = await buildMyPlan(lease({ paymentMethod: "coupon" }), { zelfName: "myname.zelf", domainConfig });
        expect(custom.upgrade.url.startsWith("https://preview.example/pricing?")).toBe(true);
        if (previous === undefined) delete process.env.LANDING_URL;
        else process.env.LANDING_URL = previous;
    });

    test("a free name that bought Premium 1y keeps the 2126 lease and drops to free caps after the plan term", async () => {
        const leaseExpiresAt = "2126-10-24 18:00:00";
        const planExpiresAt = moment().add(1, "year").format("YYYY-MM-DD HH:mm:ss");
        const active = await buildMyPlan(
            lease({
                plan: "premium",
                duration: "1",
                paymentMethod: "coupon",
                expiresAt: leaseExpiresAt,
                planExpiresAt,
            }),
            { zelfName: "myname.zelf", domainConfig }
        );
        expect(active.plan).toBe("premium");
        expect(active.duration).toBe("1y");
        expect(active.leaseExpiresAt).toBe("2126-10-24T18:00:00.000Z");
        expect(active.planExpiresAt).toBe(moment(planExpiresAt, "YYYY-MM-DD HH:mm:ss").toISOString());
        expect(active.expiresAt).toBe(active.leaseExpiresAt);
        expect(active.expiresAt).toBe("2126-10-24T18:00:00.000Z");
        expect(moment(active.planExpiresAt).diff(moment(), "year", true)).toBeGreaterThan(0.9);
        expect(moment(active.planExpiresAt).diff(moment(), "year", true)).toBeLessThan(1.2);

        const lapsed = await buildMyPlan(
            lease({
                plan: "premium",
                duration: "1",
                paymentMethod: "stripe",
                expiresAt: leaseExpiresAt,
                planExpiresAt: moment().subtract(2, "day").format("YYYY-MM-DD HH:mm:ss"),
            }),
            { zelfName: "myname.zelf", domainConfig }
        );
        expect(lapsed.plan).toBe("free");
        expect(lapsed.duration).toBeNull();
        expect(lapsed.leaseExpiresAt).toBe("2126-10-24T18:00:00.000Z");
        expect(lapsed.expiresAt).toBe(lapsed.leaseExpiresAt);
        expect(moment.utc(lapsed.planExpiresAt).isBefore(moment.utc())).toBe(true);
        expect(lapsed.nextPlans).toEqual(["premium", "unlimited"]);
    });

    test("stripe_subscription opens a billing portal and one-off stripe does not", async () => {
        const createBillingPortal = jest.fn(async (customerId) => `https://billing.stripe.com/session/${customerId}`);
        const portal = await buildMyPlan(
            lease({ paymentMethod: "stripe_subscription", stripeCustomerId: "cus_123", plan: "premium" }),
            { zelfName: "myname.zelf", domainConfig, createBillingPortal }
        );
        expect(portal.paymentMethod).toBe("stripe_subscription");
        expect(portal.upgrade).toEqual({ action: "stripe_portal", url: "https://billing.stripe.com/session/cus_123" });
        expect(createBillingPortal).toHaveBeenCalledWith("cus_123");

        const oneOff = await buildMyPlan(lease({ paymentMethod: "stripe" }), { zelfName: "myname.zelf", domainConfig, createBillingPortal });
        expect(oneOff.upgrade.action).toBe("checkout");
        expect(createBillingPortal).toHaveBeenCalledTimes(1);
    });

    test("revenuecat sends the owner to the mobile store", async () => {
        const result = await buildMyPlan(lease({ paymentMethod: "revenuecat", plan: "premium" }), {
            zelfName: "myname.zelf",
            domainConfig,
        });
        expect(result.paymentMethod).toBe("revenuecat");
        expect(result.upgrade).toEqual({ action: "mobile_store" });
    });

    test("unlimited lifetime has no upgrade", async () => {
        const result = await buildMyPlan(lease({ plan: "unlimited", duration: "lifetime", paymentMethod: "crypto" }), {
            zelfName: "myname.zelf",
            domainConfig,
        });
        expect(result.plan).toBe("unlimited");
        expect(result.duration).toBe("lifetime");
        expect(result.nextPlans).toEqual([]);
        expect(result.upgrade).toEqual({ action: "none" });
    });

    test("auth: missing session is 401, a failed match is 403, the verified owner proceeds", async () => {
        const next = jest.fn();
        const missing = { state: { user: { tagName: "myname" } }, request: { query: { zelfName: "myname.zelf" } }, status: 200 };
        await myPlanValidation(missing, next);
        expect(missing.status).toBe(401);
        expect(missing.body.code).toBe("ERR_SESSION_REQUIRED");
        expect(next).not.toHaveBeenCalled();

        const unverified = await openSession({ tagName: "myname", verifiedTagName: null, verifiedUntil: null });
        const notVerified = {
            state: { user: { session: unverified._id, domain: "zelf" } },
            request: { query: { zelfName: "myname.zelf" } },
            status: 200,
        };
        await myPlanValidation(notVerified, next);
        expect(notVerified.status).toBe(403);
        expect(notVerified.body.code).toBe("ERR_SESSION_NOT_VERIFIED");

        const other = await openSession({
            tagName: "jim",
            verifiedTagName: "jim.zelf",
            verifiedAt: new Date(),
            verifiedUntil: new Date(Date.now() + 10 * 60 * 1000),
        });
        const mismatch = {
            state: { user: { session: other._id, domain: "zelf" } },
            request: { query: { zelfName: "myname.zelf" } },
            status: 200,
        };
        await myPlanValidation(mismatch, next);
        expect(mismatch.status).toBe(403);
        expect(mismatch.body.code).toBe("ERR_SESSION_OWNER_MISMATCH");

        const expired = await openSession({
            tagName: "myname",
            verifiedTagName: "myname.zelf",
            verifiedAt: new Date(Date.now() - 20 * 60 * 1000),
            verifiedUntil: new Date(Date.now() - 60 * 1000),
        });
        const stale = {
            state: { user: { session: expired._id, domain: "zelf" } },
            request: { query: { zelfName: "myname.zelf" } },
            status: 200,
        };
        await myPlanValidation(stale, next);
        expect(stale.status).toBe(403);
        expect(stale.body.code).toBe("ERR_SESSION_NOT_VERIFIED");

        const owner = await openSession({
            tagName: "MyName",
            verifiedTagName: "MyName.Zelf",
            verifiedAt: new Date(),
            verifiedUntil: new Date(Date.now() + 10 * 60 * 1000),
        });
        const ok = {
            state: { user: { session: owner._id, domain: "zelf" } },
            request: { query: { zelfName: "myname.zelf" } },
            status: 200,
        };
        await myPlanValidation(ok, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(ok.state.verifiedZelfName).toBe("myname.zelf");
    });

    test("getMyPlan reads the lease through search", async () => {
        ZelfIdModule.searchTag.mockResolvedValue({ available: false, tagObject: lease({ paymentMethod: "coupon" }) });
        const result = await getMyPlan({ zelfName: "myname.zelf" });
        expect(result.zelfName).toBe("myname.zelf");
        expect(result.paymentMethod).toBe("coupon");
        expect(result.upgrade.action).toBe("checkout");
    });
});
