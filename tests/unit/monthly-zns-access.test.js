/**
 * Free-plan monthly ZNS access: plan exemption, one charge, grace, and the quote lock.
 * MongoDB is real (memory server). The HTTP contract is in tests/integration/monthly-zns-access-api.test.js.
 */
process.env.CONNECTION_KEY = process.env.CONNECTION_KEY || "monthly-access-test-key";
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const moment = require("moment");
const { MongoMemoryServer } = require("mongodb-memory-server");

const config = require("../../Core/config");
const { Domain } = require("../../Repositories/Tags/modules/domain.class");
const { zelfPlanLicense } = require("../fixtures/zelf-plan-license.fixture");
const { buildMyPlan } = require("../../Repositories/ZelfID/modules/zelf-ids-my-plan.module");
const {
    applyOperation,
    confirmMonthlyAccess,
    describeAmount,
    getMonthlyAccessStatus,
    operationClass,
    quoteMonthlyAccess,
} = require("../../Repositories/ZelfID/modules/zelf-id-monthly-access.module");
const MonthlyAccess = require("../../Repositories/ZelfID/models/zelf-id-monthly-access.model");
const MonthlyAccessAudit = require("../../Repositories/ZelfID/models/zelf-id-monthly-access-audit.model");
const SlotAccount = require("../../Repositories/ZelfKeys/models/zelf-key-slot-account.model");

const OCTOBER = new Date("2026-10-15T12:00:00.000Z");
const NOVEMBER = new Date("2026-11-02T00:00:00.000Z");

const domainConfig = zelfPlanLicense();

const freePublic = (zelfName) => ({
    plan: "free",
    type: "mainnet",
    tagName: zelfName,
    zelfName,
    expiresAt: "2126-01-01 00:00:00",
});

const open = (overrides = {}) => {
    const zelfName = overrides.zelfName || "myname.zelf";
    return applyOperation({
        trigger: "retrieve",
        zelfName,
        domain: "zelf",
        plan: "free",
        publicData: freePublic(zelfName),
        domainConfig,
        balance: 1000,
        tokenPriceUsd: 0.05,
        floorUsd: 0.1,
        skipSubscriptionLookup: true,
        now: OCTOBER,
        ...overrides,
        publicData: overrides.publicData || freePublic(overrides.zelfName || zelfName),
    });
};

describe("monthly ZNS access", () => {
    let memory;
    const previousFlag = process.env.MONTHLY_ZNS_ACCESS_ENABLED;

    beforeAll(async () => {
        process.env.MONTHLY_ZNS_ACCESS_ENABLED = "true";
        memory = await MongoMemoryServer.create();
        await mongoose.connect(memory.getUri());
        await MonthlyAccess.init();
        await MonthlyAccessAudit.init();
        await SlotAccount.init();
    }, 180000);

    afterAll(async () => {
        if (previousFlag === undefined) delete process.env.MONTHLY_ZNS_ACCESS_ENABLED;
        else process.env.MONTHLY_ZNS_ACCESS_ENABLED = previousFlag;
        await mongoose.disconnect();
        if (memory) await memory.stop();
    });

    beforeEach(async () => {
        process.env.MONTHLY_ZNS_ACCESS_ENABLED = "true";
        delete process.env.MONTHLY_ZNS_ACCESS_FLOOR_USD;
        await MonthlyAccess.deleteMany({});
        await MonthlyAccessAudit.deleteMany({});
        await SlotAccount.deleteMany({});
    });

    test("amount is yearly premium / 12 in whole ZNS, with the extra-slot rounding and the floor", () => {
        const quoted = describeAmount({ tagName: "myname.zelf", domainConfig, tokenPriceUsd: 0.05, floorUsd: 0.1 });
        expect(quoted.premiumYearlyUsd).toBe(29);
        expect(quoted.amountUsd).toBe("2.4166666667");
        expect(quoted.premiumZns).toBe(49);
        expect(quoted.floorZns).toBe(2);
        expect(quoted.amountZns).toBe(49);

        const exact = new Domain({
            name: "zelf",
            tags: {
                minLength: 1,
                maxLength: 27,
                payment: { planPricing: { premium: { "1-27": { 1: 6 } } } },
            },
        });
        const ten = describeAmount({ tagName: "myname.zelf", domainConfig: exact, tokenPriceUsd: 0.05, floorUsd: 0.1 });
        expect(ten.premiumZns).toBe(10);
        expect(ten.amountZns).toBe(10);

        const floored = describeAmount({ tagName: "myname.zelf", domainConfig, tokenPriceUsd: 0.05, floorUsd: 5 });
        expect(floored.floorZns).toBe(100);
        expect(floored.amountZns).toBe(100);

        const short = describeAmount({ tagName: "abc.zelf", domainConfig, tokenPriceUsd: 0.05, floorUsd: 0.1 });
        expect(short.premiumYearlyUsd).toBe(29);
        expect(short.amountZns).toBe(49);
    });

    test("active premium and unlimited, including coupon and whitelist, are exempt", async () => {
        const premium = await open({
            zelfName: "coupon.zelf",
            plan: undefined,
            publicData: {
                plan: "premium",
                type: "mainnet",
                tagName: "coupon.zelf",
                paymentMethod: "coupon",
                planExpiresAt: "2027-10-01 00:00:00",
                expiresAt: "2126-10-01 00:00:00",
            },
            balance: 0,
        });
        expect(premium.allowed).toBe(true);
        expect(premium.status).toBe("exempt");
        expect(premium.reason).toBe("premium");

        const unlimited = await open({
            zelfName: "listed.zelf",
            plan: undefined,
            publicData: {
                plan: "unlimited",
                type: "mainnet",
                tagName: "listed.zelf",
                paymentMethod: "whitelist",
                planExpiresAt: "2027-10-01 00:00:00",
                expiresAt: "2126-10-01 00:00:00",
            },
            balance: 0,
        });
        expect(unlimited.status).toBe("exempt");
        expect(unlimited.reason).toBe("unlimited");

        const keysPlan = await open({
            zelfName: "sub.zelf",
            plan: "free",
            subscriptionPlan: "premium",
            balance: 0,
        });
        expect(keysPlan.status).toBe("exempt");
        expect(keysPlan.reason).toBe("premium");

        expect(await MonthlyAccess.countDocuments()).toBe(0);
        expect(await SlotAccount.countDocuments()).toBe(0);
    });

    test("a lapsed premium term is charged on the next triggering open", async () => {
        const result = await open({
            zelfName: "lapsed.zelf",
            plan: undefined,
            publicData: {
                plan: "premium",
                type: "mainnet",
                tagName: "lapsed.zelf",
                paymentMethod: "coupon",
                planExpiresAt: "2020-01-01 00:00:00",
                expiresAt: "2126-01-01 00:00:00",
            },
        });
        expect(result.allowed).toBe(true);
        expect(result.status).toBe("paid");
        expect(result.charged).toBe(true);
        expect(result.receipt.amountZns).toBe(49);
        const account = await SlotAccount.findOne({ zelfName: "lapsed.zelf" }).lean();
        expect(account.spent).toBe(49);
    });

    test("the first open charges once, including parallel requests", async () => {
        const first = await open({ zelfName: "once.zelf" });
        expect(first.charged).toBe(true);
        expect(first.receipt.amountZns).toBe(49);
        expect(first.receipt.charged).toBe(true);

        const again = await open({ zelfName: "once.zelf" });
        expect(again.allowed).toBe(true);
        expect(again.charged).toBe(false);
        expect(again.idempotent).toBe(true);

        const parallelName = "parallel.zelf";
        const results = await Promise.all(Array.from({ length: 8 }, () => open({ zelfName: parallelName })));
        expect(results.every((row) => row.allowed)).toBe(true);
        expect(results.filter((row) => row.charged).length).toBe(1);

        const once = await SlotAccount.findOne({ zelfName: "once.zelf" }).lean();
        const parallel = await SlotAccount.findOne({ zelfName: parallelName }).lean();
        expect(once.spent).toBe(49);
        expect(parallel.spent).toBe(49);
        expect(await MonthlyAccess.countDocuments({ zelfName: parallelName, status: "paid" })).toBe(1);
        expect(await MonthlyAccessAudit.countDocuments({ zelfName: parallelName, event: "paid" })).toBe(1);
    });

    test("a quiet month is not charged, and exempt operations do not open the month", async () => {
        const status = await getMonthlyAccessStatus({
            zelfName: "quiet.zelf",
            plan: "free",
            publicData: freePublic("quiet.zelf"),
            domainConfig,
            balance: 0,
            tokenPriceUsd: 0.05,
            floorUsd: 0.1,
            now: OCTOBER,
            skipSubscriptionLookup: true,
        });
        expect(status.status).toBe("none");
        expect(status.openAllowed).toBe(true);
        expect(await MonthlyAccess.countDocuments({ zelfName: "quiet.zelf" })).toBe(0);

        for (const trigger of ["daily-reward", "store", "delete", "password-change", "preview", "slot-purchase", "payment-confirmation"]) {
            expect(operationClass(trigger)).toBe("exempt");
            const result = await open({ zelfName: "quiet.zelf", trigger, balance: 0 });
            expect(result.allowed).toBe(true);
            expect(result.charged).toBe(false);
        }
        expect(await MonthlyAccess.countDocuments({ zelfName: "quiet.zelf" })).toBe(0);
        expect(await SlotAccount.countDocuments({ zelfName: "quiet.zelf" })).toBe(0);
    });

    test("wallet export and lease recovery stay available and do not consume grace", async () => {
        expect(operationClass("wallet-export")).toBe("exempt");
        expect(operationClass("lease-recovery")).toBe("exempt");

        const grace = await open({ zelfName: "export.zelf", balance: 0 });
        expect(grace.status).toBe("grace");

        const exported = await open({ zelfName: "export.zelf", trigger: "wallet-export", balance: 0 });
        const recovered = await open({ zelfName: "export.zelf", trigger: "lease-recovery", balance: 0 });
        expect(exported.allowed).toBe(true);
        expect(recovered.allowed).toBe(true);

        const blocked = await open({ zelfName: "export.zelf", balance: 0 });
        expect(blocked.allowed).toBe(false);
        expect(blocked.body.code).toBe("monthly_access_payment_required");
        expect(await MonthlyAccess.countDocuments({ zelfName: "export.zelf" })).toBe(1);
        const account = await SlotAccount.findOne({ zelfName: "export.zelf" }).lean();
        expect(account).toBeNull();
    });

    test("short balance grants one grace open, then blocks without a negative balance", async () => {
        const name = "grace.zelf";
        const first = await open({ zelfName: name, balance: 3 });
        expect(first.allowed).toBe(true);
        expect(first.status).toBe("grace");
        expect(first.charged).toBe(false);
        expect(first.receipt.amountZns).toBe(49);
        expect(first.receipt.amountUsd).toBe("2.4166666667");

        const results = await Promise.all(Array.from({ length: 6 }, () => open({ zelfName: name, balance: 3 })));
        expect(results.every((row) => row.allowed === false)).toBe(true);
        expect(results[0].body).toMatchObject({
            code: "monthly_access_payment_required",
            amountZns: 49,
            amountUsd: "2.4166666667",
            znsNeeded: 46,
        });
        expect(results[0].body.options.map((option) => option.type)).toEqual(["upgrade", "card", "zns"]);
        expect(results[0].body.options.find((option) => option.type === "card").available).toBe(false);

        expect(await MonthlyAccess.countDocuments({ zelfName: name, status: "grace" })).toBe(1);
        const spent = await SlotAccount.findOne({ zelfName: name }).lean();
        expect(spent).toBeNull();
        expect(await MonthlyAccessAudit.countDocuments({ zelfName: name, event: "grace_opened" })).toBe(1);
        expect(await MonthlyAccessAudit.countDocuments({ zelfName: name, event: "grace_blocked" })).toBe(6);
    });

    test("parallel first opens with a short balance record grace once", async () => {
        const name = "grace-race.zelf";
        const results = await Promise.all(Array.from({ length: 8 }, () => open({ zelfName: name, balance: 0 })));
        expect(results.filter((row) => row.allowed && row.status === "grace").length).toBe(1);
        expect(results.filter((row) => row.blocked).length).toBe(7);
        expect(await MonthlyAccess.countDocuments({ zelfName: name })).toBe(1);
    });

    test("ZNS payment converts grace to paid and a second confirm does not debit again", async () => {
        const name = "pay.zelf";
        await open({ zelfName: name, balance: 1 });
        const authUser = { tagName: "pay", domain: "zelf" };
        const quote = await quoteMonthlyAccess({
            zelfName: name,
            authUser,
            plan: "free",
            publicData: freePublic(name),
            domainConfig,
            balance: 1,
            tokenPriceUsd: 0.05,
            floorUsd: 0.1,
            now: OCTOBER,
            skipSubscriptionLookup: true,
        });
        expect(quote.amountZns).toBe(49);
        expect(quote.ttl).toBeGreaterThan(moment.utc(OCTOBER).unix());

        const confirmed = jwt.verify(quote.signedDataPrice, config.JWT_SECRET);
        confirmed.ttl = moment.utc(OCTOBER).subtract(1, "minute").unix();
        const expired = jwt.sign(confirmed, config.JWT_SECRET);
        await expect(
            confirmMonthlyAccess({
                token: expired,
                authUser,
                plan: "free",
                publicData: freePublic(name),
                domainConfig,
                balance: 1000,
                now: OCTOBER,
                skipSubscriptionLookup: true,
            }),
        ).rejects.toMatchObject({ clientCode: "monthly_access_quote_expired" });
        expect(await SlotAccount.countDocuments({ zelfName: name })).toBe(0);

        await expect(
            confirmMonthlyAccess({
                token: quote.signedDataPrice,
                method: "card",
                authUser,
                plan: "free",
                publicData: freePublic(name),
                domainConfig,
                balance: 1000,
                now: OCTOBER,
                skipSubscriptionLookup: true,
            }),
        ).rejects.toMatchObject({ clientCode: "monthly_access_card_unavailable" });

        const paid = await confirmMonthlyAccess({
            token: quote.signedDataPrice,
            method: "zns",
            authUser,
            plan: "free",
            publicData: freePublic(name),
            domainConfig,
            balance: 1000,
            tokenPriceUsd: 1,
            now: OCTOBER,
            skipSubscriptionLookup: true,
        });
        expect(paid.status).toBe("paid");
        expect(paid.settlement).toBe("zns");
        expect(paid.charged).toBe(true);
        expect(paid.amountZns).toBe(49);

        const replay = await confirmMonthlyAccess({
            token: quote.signedDataPrice,
            authUser,
            plan: "free",
            publicData: freePublic(name),
            domainConfig,
            balance: 1000,
            now: OCTOBER,
            skipSubscriptionLookup: true,
        });
        expect(replay.idempotent).toBe(true);
        expect(replay.charged).toBe(false);

        const account = await SlotAccount.findOne({ zelfName: name }).lean();
        expect(account.spent).toBe(49);
        expect(account.spent).toBeGreaterThanOrEqual(0);

        const opened = await open({ zelfName: name, balance: 0 });
        expect(opened.allowed).toBe(true);
        expect(opened.status).toBe("paid");
        expect(account.spent).toBe(49);
    });

    test("an active paid plan lifts a grace block", async () => {
        const name = "upgrade.zelf";
        await open({ zelfName: name, balance: 0 });
        const lifted = await open({
            zelfName: name,
            balance: 0,
            plan: undefined,
            publicData: {
                plan: "premium",
                type: "mainnet",
                tagName: name,
                paymentMethod: "stripe",
                planExpiresAt: "2027-12-01 00:00:00",
                expiresAt: "2126-01-01 00:00:00",
            },
        });
        expect(lifted.allowed).toBe(true);
        expect(lifted.status).toBe("exempt");
        const row = await MonthlyAccess.findOne({ zelfName: name }).lean();
        expect(row.status).toBe("grace");
        expect(await SlotAccount.countDocuments({ zelfName: name })).toBe(0);
    });

    test("unpaid grace removes grace the next month; a paid month keeps it", async () => {
        const unpaid = "unpaid-next.zelf";
        await open({ zelfName: unpaid, balance: 0, now: OCTOBER });
        const blocked = await open({ zelfName: unpaid, balance: 0, now: NOVEMBER });
        expect(blocked.allowed).toBe(false);
        expect(blocked.body.code).toBe("monthly_access_payment_required");
        expect(await MonthlyAccess.countDocuments({ zelfName: unpaid, periodKey: "2026-11" })).toBe(0);

        const covered = await open({ zelfName: unpaid, balance: 1000, now: NOVEMBER });
        expect(covered.status).toBe("paid");
        expect(covered.charged).toBe(true);

        const paidName = "paid-next.zelf";
        await open({ zelfName: paidName, balance: 1000, now: OCTOBER });
        const nextGrace = await open({ zelfName: paidName, balance: 0, now: NOVEMBER });
        expect(nextGrace.allowed).toBe(true);
        expect(nextGrace.status).toBe("grace");

        const quietThenGrace = await open({ zelfName: "fresh-next.zelf", balance: 0, now: NOVEMBER });
        expect(quietThenGrace.status).toBe("grace");
    });

    test("the fee stays off unless MONTHLY_ZNS_ACCESS_ENABLED is true", async () => {
        process.env.MONTHLY_ZNS_ACCESS_ENABLED = "false";
        const result = await open({ zelfName: "off.zelf", balance: 0 });
        expect(result.allowed).toBe(true);
        expect(result.status).toBe("disabled");
        expect(await MonthlyAccess.countDocuments({ zelfName: "off.zelf" })).toBe(0);

        const plan = await buildMyPlan(
            {
                publicData: {
                    tagName: "off.zelf",
                    type: "mainnet",
                    plan: "free",
                    expiresAt: "2126-01-01 00:00:00",
                },
            },
            { zelfName: "off.zelf", domainConfig },
        );
        expect(plan.monthlyAccess).toBeUndefined();
    });

    test("my-plan includes the month status when the fee is enabled", async () => {
        await open({ zelfName: "myname.zelf", balance: 0, now: OCTOBER });
        const plan = await buildMyPlan(
            { publicData: freePublic("myname.zelf") },
            { zelfName: "myname.zelf", domainConfig, authUser: { tagName: "myname", domain: "zelf" } },
        );
        expect(plan.monthlyAccess).toMatchObject({
            enabled: true,
            zelfName: "myname.zelf",
            plan: "free",
            status: "grace",
            openAllowed: false,
            amountZns: 49,
        });
        expect(plan.monthlyAccess.znsNeeded).toBeGreaterThan(0);
    });
});
