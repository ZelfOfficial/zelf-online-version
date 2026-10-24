/**
 * Zelf ID plan coupons: quote reasons, 100% free-checkout grant, partial discount,
 * Stripe minimum, super-admin gate, and a conditional redemption so two parallel
 * confirms of a max-1 coupon cannot both succeed.
 */
const mongoose = require("mongoose");
const moment = require("moment");
const jwt = require("jsonwebtoken");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { Domain } = require("../../Repositories/Tags/modules/domain.class");
const { zelfPlanLicenseData } = require("../fixtures/zelf-plan-license.fixture");

let domainConfig;

jest.mock("../../Repositories/Tags/modules/tag-smart-contract-payment.module", () => ({
    throwPaymentConfirmationTagNotFound: jest.fn((tagName, domain) => {
        throw new Error(`404:${tagName}.${domain}`);
    }),
    verifySmartContractPayment: jest.fn(),
}));

jest.mock("../../Repositories/Tags/modules/my-tags.module", () => ({
    confirmPayUniqueAddress: jest.fn(),
}));

jest.mock("../../Repositories/Tags/middlewares/my-tags.middleware", () => ({}));

jest.mock("../../Repositories/Tags/config/supported-domains", () => ({
    getDomainConfig: () => domainConfig,
}));

jest.mock("../../Repositories/ZelfID/modules/zelf-id.module", () => ({
    searchTag: jest.fn(),
    _validateReferral: jest.fn(),
}));

jest.mock("../../Repositories/Tags/modules/tags-search.module", () => ({
    searchTag: jest.fn(async () => ({
        tagObject: {
            id: "tagpay-1",
            publicData: {
                ethAddress: "0xeth",
                btcAddress: "btc",
                solanaAddress: "sol",
                count: "1",
                duration: "1",
                registeredAt: "2020-01-01 00:00:00",
                expiresAt: "2126-01-01 00:00:00",
            },
        },
    })),
}));

const Coupon = require("../../Repositories/ZelfID/models/zelf-id-coupon.model");
const Coupons = require("../../Repositories/ZelfID/modules/zelf-ids-coupons.module");
const { getPaymentOptions } = require("../../Repositories/ZelfID/modules/zelf-ids-payment.module");
const { verifyPaymentConfirmation } = require("../../Repositories/ZelfID/modules/my-zelf-id.module");
const { unitAmountForCharge, buildLeaseStripeMetadata, confirmPaidStripeSession } = require("../../Repositories/ZelfID/modules/zelf-ids-stripe.module");
const ZelfIdModule = require("../../Repositories/ZelfID/modules/zelf-id.module");
const config = require("../../Core/config");
const CouponMiddleware = require("../../Repositories/ZelfID/middlewares/zelf-ids-coupons.middleware");
const TagsMiddleware = require("../../Repositories/Tags/middlewares/tags.middleware");
const PaymentMiddleware = require("../../Repositories/ZelfID/middlewares/zelf-id.middleware");

const license = () =>
    new Domain({
        ...zelfPlanLicenseData(),
        tags: {
            ...zelfPlanLicenseData().tags,
            storage: { keyPrefix: "tagName", ipfsEnabled: false, arweaveEnabled: false, walrusEnabled: false },
        },
    });

const tagFor = (bare, extra = {}) => ({
    zelfProofQRCode: "qr",
    publicData: {
        tagName: `${bare}.zelf`,
        type: "mainnet",
        plan: "free",
        duration: "1",
        v: "4",
        origin: "online",
        hasPassword: "true",
        expiresAt: moment().add(50, "year").format("YYYY-MM-DD HH:mm:ss"),
        registeredAt: moment().subtract(10, "day").format("YYYY-MM-DD HH:mm:ss"),
        ...extra,
    },
});

const signQuote = (bare, coupon, extra = {}) =>
    jwt.sign(
        {
            tagName: `${bare}.zelf`,
            tagPayName: `${bare}.zelfpay`,
            plan: "premium",
            duration: 1,
            initiatedAt: moment().unix(),
            ttl: moment().add(2, "hour").unix(),
            freeCheckout: true,
            amountDue: 0,
            billableUsdPrice: 0,
            coupon: { id: coupon.id, code: coupon.code, valid: true },
            ...extra,
        },
        config.JWT_SECRET
    );

describe("Zelf ID plan coupons", () => {
    let memory;

    beforeAll(async () => {
        if (!config.JWT_SECRET) config.JWT_SECRET = "test-jwt-secret-key-for-testing-only";
        domainConfig = license();
        memory = await MongoMemoryServer.create();
        await mongoose.connect(memory.getUri());
    }, 180000);

    afterAll(async () => {
        await mongoose.disconnect();
        if (memory) await memory.stop();
    });

    beforeEach(async () => {
        await Coupon.deleteMany({});
        const tags = new Map();
        ZelfIdModule.searchTag.mockImplementation(async ({ tagName }) => {
            const bare = `${tagName}`.split(".")[0].toLowerCase();
            if (!tags.has(bare)) tags.set(bare, tagFor(bare));
            return { available: false, tagName: bare, tagObject: tags.get(bare), ipfs: [] };
        });
    });

    test("create stores an uppercase code and logs it", async () => {
        const spy = jest.spyOn(console, "info").mockImplementation(() => {});
        const created = await Coupons.createCoupon(
            {
                code: "save100",
                percentOff: 100,
                plans: ["premium", "unlimited"],
                durations: ["1y", "lifetime"],
                maxRedemptions: 50,
                expiresAt: "2026-12-31T23:59:59.000Z",
            },
            "admin@zelf.world"
        );
        expect(created).toMatchObject({
            code: "SAVE100",
            percentOff: 100,
            plans: ["premium", "unlimited"],
            durations: ["1y", "lifetime"],
            maxRedemptions: 50,
            perZelfIdLimit: 1,
            active: true,
            createdBy: "admin@zelf.world",
            redemptions: [],
            expiresAt: "2026-12-31T23:59:59.000Z",
        });
        expect(created.id).toEqual(expect.any(String));
        expect(spy).toHaveBeenCalledWith("[zelf-id-coupon] created", expect.objectContaining({ code: "SAVE100", createdBy: "admin@zelf.world" }));
        await expect(Coupons.createCoupon({ code: "SAVE100", percentOff: 10, plans: ["premium"], maxRedemptions: 1 }, "admin@zelf.world")).rejects.toMatchObject({
            clientCode: "coupon_code_taken",
            clientMessage: "coupon_code_taken",
        });
        spy.mockRestore();
    });

    test("quote reports every rejection reason, in order, without writing a redemption", async () => {
        expect((await Coupons.describeCoupon({ code: "missing", plan: "premium", duration: "1", zelfId: "myname.zelf", listPrice: 24 })).coupon).toEqual({
            code: "MISSING",
            valid: false,
            reason: "not_found",
        });

        const expired = await Coupons.createCoupon(
            { code: "old", percentOff: 25, plans: ["premium"], maxRedemptions: 1, expiresAt: "2020-01-01T00:00:00.000Z" },
            "admin@zelf.world"
        );
        const expiredQuote = await Coupons.describeCoupon({ code: "OLD", plan: "premium", duration: "1", zelfId: "myname.zelf", listPrice: 24 });
        expect(expiredQuote).toMatchObject({ valid: false, percentOff: 0, amountDue: 24, listPrice: 24, currency: "USD" });
        expect(expiredQuote.coupon).toEqual({ code: "OLD", valid: false, reason: "expired" });

        await Coupons.deactivateCoupon(expired.id);
        const inactive = await Coupons.describeCoupon({ code: "old", plan: "premium", duration: "1", zelfId: "myname.zelf", listPrice: 24 });
        expect(inactive.coupon.reason).toBe("inactive");

        const limited = await Coupons.createCoupon(
            { code: "once", percentOff: 100, plans: ["unlimited"], durations: ["lifetime"], maxRedemptions: 1, perZelfIdLimit: 1 },
            "admin@zelf.world"
        );
        expect(
            (await Coupons.describeCoupon({ code: "once", plan: "premium", duration: "1", zelfId: "myname.zelf", listPrice: 24 })).coupon.reason
        ).toBe("plan_not_allowed");
        expect(
            (await Coupons.describeCoupon({ code: "once", plan: "unlimited", duration: "1", zelfId: "myname.zelf", listPrice: 24 })).coupon.reason
        ).toBe("duration_not_allowed");

        await Coupons.claimForGrant({
            code: limited.code,
            zelfId: "myname.zelf",
            plan: "unlimited",
            duration: "lifetime",
            domainConfig,
            tagName: "myname",
            signedAmount: 0,
            requireZero: true,
        });
        expect(
            (await Coupons.describeCoupon({ code: "once", plan: "unlimited", duration: "lifetime", zelfId: "other.zelf", listPrice: 24 })).coupon.reason
        ).toBe("max_redemptions");

        const perName = await Coupons.createCoupon(
            { code: "perid", percentOff: 100, plans: ["premium"], maxRedemptions: 5, perZelfIdLimit: 1 },
            "admin@zelf.world"
        );
        await Coupons.claimForGrant({
            code: perName.code,
            zelfId: "myname.zelf",
            plan: "premium",
            duration: "1",
            domainConfig,
            tagName: "myname",
            signedAmount: 0,
            requireZero: true,
        });
        expect(
            (await Coupons.describeCoupon({ code: "perid", plan: "premium", duration: "1", zelfId: "MyName.zelf", listPrice: 24 })).coupon.reason
        ).toBe("zelf_id_limit");

        const stored = await Coupon.findOne({ code: "PERID" }).lean();
        expect(stored.redemptions).toHaveLength(1);
        expect(stored.redemptions[0]).toMatchObject({ zelfId: "myname.zelf", plan: "premium", duration: "1y" });
    });

    test("partial percent-off discounts the license list price to the cent", async () => {
        const created = await Coupons.createCoupon({ code: "save25", percentOff: 25, plans: ["premium"], maxRedemptions: 10 }, "admin@zelf.world");
        const described = await Coupons.describeCoupon({ code: "save25", plan: "premium", duration: "1", zelfId: "myname.zelf", listPrice: 24 });
        expect(described).toMatchObject({ valid: true, listPrice: 24, percentOff: 25, amountDue: 18, currency: "USD" });
        expect(described.coupon).toEqual({ id: created.id, code: "SAVE25", valid: true });
        expect(Coupons.amountDueFor(29, 10)).toBe(26.1);
    });

    test("payment-options returns the discounted quote, or the normal quote plus coupon.reason", async () => {
        ZelfIdModule.searchTag.mockResolvedValue({
            available: false,
            tagName: "myname",
            tagObject: tagFor("myname", { registeredAt: "2019-01-01 00:00:00" }),
            ipfs: [],
        });
        await Coupons.createCoupon({ code: "save25", percentOff: 25, plans: ["premium"], maxRedemptions: 10 }, "admin@zelf.world");
        const quote = await getPaymentOptions("myname", "zelf", "1", {}, { requestedPlan: "premium", coupon: "save25" });
        const list = quote.listPrice;
        expect(quote.percentOff).toBe(25);
        expect(quote.amountDue).toBe(Coupons.amountDueFor(list, 25));
        expect(quote.billableUsdPrice).toBe(quote.amountDue);
        expect(quote.currency).toBe("USD");
        expect(quote.coupon).toMatchObject({ code: "SAVE25", valid: true });
        expect(quote.freeCheckout).toBe(false);
        const decoded = jwt.verify(quote.signedDataPrice, config.JWT_SECRET);
        expect(decoded.amountDue).toBe(quote.amountDue);
        expect(decoded.coupon.valid).toBe(true);

        await Coupons.createCoupon(
            { code: "gone", percentOff: 50, plans: ["premium"], maxRedemptions: 1, expiresAt: "2020-01-01T00:00:00.000Z" },
            "admin@zelf.world"
        );
        const rejected = await getPaymentOptions("myname", "zelf", "1", {}, { requestedPlan: "premium", coupon: "gone" });
        expect(rejected.coupon).toEqual({ code: "GONE", valid: false, reason: "expired" });
        expect(rejected.percentOff).toBe(0);
        expect(rejected.amountDue).toBe(rejected.listPrice);
        expect(rejected.freeCheckout).toBe(false);
        expect(rejected.billableUsdPrice).toBe(rejected.listPrice);

        await Coupons.createCoupon({ code: "save100", percentOff: 100, plans: ["premium"], maxRedemptions: 2 }, "admin@zelf.world");
        const freeQuote = await getPaymentOptions("myname", "zelf", "1", {}, { requestedPlan: "premium", coupon: "SAVE100" });
        expect(freeQuote.amountDue).toBe(0);
        expect(freeQuote.percentOff).toBe(100);
        expect(freeQuote.freeCheckout).toBe(true);
        expect(freeQuote.coupon.valid).toBe(true);
    });

    test("a 100% coupon grants on the free-checkout path and a replay does not redeem twice", async () => {
        const created = await Coupons.createCoupon(
            { code: "free100", percentOff: 100, plans: ["premium", "unlimited"], maxRedemptions: 5 },
            "admin@zelf.world"
        );
        const bare = "couponaa";
        const token = signQuote(bare, created, { initiatedAt: moment().subtract(5, "minutes").unix() });
        const granted = await verifyPaymentConfirmation(bare, "zelf", "FREE", token);
        expect(granted.confirmed).toBe(true);
        expect(granted.paymentMethod).toBe("coupon");
        expect(granted.couponId).toBe(created.id);
        expect(granted.amountReceived).toBe(0);
        expect(granted.tagObject.publicData.plan).toBe("premium");
        expect(granted.tagObject.publicData.payment).toEqual({ method: "coupon", couponId: created.id });
        expect(granted.tagObject.publicData.paymentMethod).toBe("coupon");

        const replay = await verifyPaymentConfirmation(bare, "zelf", "FREE", token);
        expect(replay.cache).toBe(true);
        expect(replay.confirmed).toBe(true);
        expect(replay.paymentMethod).toBe("coupon");

        const saved = await Coupon.findOne({ code: "FREE100" }).lean();
        expect(saved.redemptions).toHaveLength(1);
        expect(saved.redemptions[0]).toMatchObject({ zelfId: "couponaa.zelf", plan: "premium", duration: "1y" });
    });

    test("two parallel redemptions of a max-1 coupon let only one grant succeed", async () => {
        const created = await Coupons.createCoupon(
            { code: "race", percentOff: 100, plans: ["premium", "unlimited"], maxRedemptions: 1, perZelfIdLimit: 1 },
            "admin@zelf.world"
        );
        const attempt = (bare) => verifyPaymentConfirmation(bare, "zelf", "FREE", signQuote(bare, created));
        const settled = await Promise.allSettled([attempt("raceaa1"), attempt("racebb1")]);
        const fulfilled = settled.filter((result) => result.status === "fulfilled");
        const rejected = settled.filter((result) => result.status === "rejected");
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(fulfilled[0].value.confirmed).toBe(true);
        expect(fulfilled[0].value.paymentMethod).toBe("coupon");
        expect(rejected[0].reason.clientCode).toBe("max_redemptions");
        expect(rejected[0].reason.message).toContain("coupon_invalid");
        const saved = await Coupon.findOne({ code: "RACE" }).lean();
        expect(saved.redemptions).toHaveLength(1);
    });

    test("plan rules still block a 100% coupon and do not write a redemption", async () => {
        const created = await Coupons.createCoupon(
            { code: "rules", percentOff: 100, plans: ["premium", "unlimited"], maxRedemptions: 5 },
            "admin@zelf.world"
        );
        ZelfIdModule.searchTag.mockResolvedValue({
            available: false,
            tagName: "downgrade",
            tagObject: tagFor("downgrade", {
                plan: "unlimited",
                expiresAt: moment().add(1, "year").format("YYYY-MM-DD HH:mm:ss"),
            }),
            ipfs: [],
        });
        await expect(verifyPaymentConfirmation("downgrade", "zelf", "FREE", signQuote("downgrade", created))).rejects.toMatchObject({
            clientCode: "downgrade_not_allowed",
            clientMessage: "downgrade_not_allowed",
        });

        ZelfIdModule.searchTag.mockResolvedValue({
            available: false,
            tagName: "ab",
            tagObject: tagFor("ab"),
            ipfs: [],
        });
        await expect(verifyPaymentConfirmation("ab", "zelf", "FREE", signQuote("ab", created))).rejects.toMatchObject({
            clientCode: "plan_not_allowed_for_name",
        });

        ZelfIdModule.searchTag.mockResolvedValue({
            available: false,
            tagName: "lifetime",
            tagObject: tagFor("lifetime", {
                plan: "premium",
                duration: "lifetime",
                expiresAt: moment().add(80, "year").format("YYYY-MM-DD HH:mm:ss"),
            }),
            ipfs: [],
        });
        await expect(verifyPaymentConfirmation("lifetime", "zelf", "FREE", signQuote("lifetime", created))).rejects.toMatchObject({
            clientCode: "lifetime_already_owned",
        });

        const saved = await Coupon.findOne({ code: "RULES" }).lean();
        expect(saved.redemptions).toEqual([]);
    });

    test("a partial coupon is redeemed when the Stripe grant matches the recomputed total", async () => {
        const created = await Coupons.createCoupon({ code: "half", percentOff: 50, plans: ["premium"], maxRedemptions: 3 }, "admin@zelf.world");
        const priced = await Coupons.priceCoupon({
            code: "half",
            plan: "premium",
            duration: "1",
            zelfId: "couponcc.zelf",
            tagName: "couponcc",
            domainConfig,
        });
        expect(priced.valid).toBe(true);
        expect(priced.amountDue).toBe(Coupons.amountDueFor(priced.listPrice, 50));
        expect(priced.amountDue).toBeGreaterThan(0);

        ZelfIdModule.searchTag.mockResolvedValue({
            available: false,
            tagName: "couponcc",
            tagObject: tagFor("couponcc"),
            ipfs: [],
        });
        const result = await confirmPaidStripeSession({
            id: "cs_test_coupon",
            payment_status: "paid",
            created: moment().subtract(1, "minute").unix(),
            amount_total: Math.round(priced.amountDue * 100),
            metadata: buildLeaseStripeMetadata({
                tagName: "couponcc",
                domain: "zelf",
                duration: "1",
                plan: "premium",
                amountUsd: priced.amountDue,
                couponId: created.id,
                couponCode: created.code,
            }),
        });
        expect(result.confirmed).toBe(true);
        expect(result.tagObject.publicData.plan).toBe("premium");
        expect(result.tagObject.publicData.couponId).toBe(created.id);
        expect(result.tagObject.publicData.paymentMethod).toBeUndefined();
        const saved = await Coupon.findOne({ code: "HALF" }).lean();
        expect(saved.redemptions).toHaveLength(1);
        expect(saved.redemptions[0].duration).toBe("1y");
    });

    test("Stripe keeps a 50-cent minimum and rejects a discounted total under it", () => {
        expect(unitAmountForCharge(18, { coupon: true })).toBe(1800);
        expect(unitAmountForCharge(0.2)).toBe(50);
        expect(() => unitAmountForCharge(0.4, { coupon: true })).toThrow("409:stripe_amount_below_minimum");
        try {
            unitAmountForCharge(0.4, { coupon: true });
        } catch (error) {
            expect(error.clientCode).toBe("stripe_amount_below_minimum");
            expect(error.clientMessage).toBe("Discounted total is below the Stripe minimum of $0.50");
        }
        try {
            unitAmountForCharge(0, { coupon: true });
        } catch (error) {
            expect(error.clientCode).toBe("invalid_quote_amount");
            expect(error.clientMessage).toContain("payment confirmation");
        }
    });

    test("non-admins cannot create coupons, and percentOff is validated", async () => {
        const next = jest.fn();
        const denied = { state: { user: { tagName: "someone.zelf" } }, request: { body: {} }, status: 200, body: undefined };
        await CouponMiddleware.requireSuperAdmin(denied, next);
        expect(denied.status).toBe(403);
        expect(denied.body).toEqual({ error: "Super-admin access required", code: "super_admin_required" });
        expect(next).not.toHaveBeenCalled();

        const allowed = { state: { user: { superAdminId: "admin-id" } }, status: 200 };
        await CouponMiddleware.requireSuperAdmin(allowed, next);
        expect(next).toHaveBeenCalledTimes(1);

        const invalid = { request: { body: { code: "X", percentOff: 0, plans: ["premium"], maxRedemptions: 1 } }, status: 200, body: undefined };
        await CouponMiddleware.createValidation(invalid, next);
        expect(invalid.status).toBe(409);
        expect(invalid.body.validationError).toBe('"percentOff" must be between 1 and 100');
    });

    test("omitted network is accepted only for a signed $0 quote", async () => {
        const validate = jest.spyOn(TagsMiddleware, "validateDomainAndName").mockResolvedValue({ valid: true });
        const next = jest.fn();
        const token = jwt.sign(
            {
                tagName: "myname.zelf",
                tagPayName: "myname.zelfpay",
                ttl: moment().add(1, "hour").unix(),
                freeCheckout: true,
            },
            config.JWT_SECRET
        );
        const ctx = { request: { body: { tagName: "myname", domain: "zelf", token } }, status: 200, body: undefined };
        await PaymentMiddleware.paymentConfirmationValidation(ctx, next);
        expect(ctx.request.body.network).toBe("FREE");
        expect(next).toHaveBeenCalled();

        const paid = jwt.sign(
            {
                tagName: "myname.zelf",
                tagPayName: "myname.zelfpay",
                ttl: moment().add(1, "hour").unix(),
                freeCheckout: false,
                prices: { ETH: { amountToSend: 1, price: 24 } },
            },
            config.JWT_SECRET
        );
        const needsNetwork = { request: { body: { tagName: "myname", domain: "zelf", token: paid } }, status: 200, body: undefined };
        const nextPaid = jest.fn();
        await PaymentMiddleware.paymentConfirmationValidation(needsNetwork, nextPaid);
        expect(needsNetwork.status).toBe(409);
        expect(needsNetwork.body).toEqual({ validationError: '"network" is required' });
        expect(nextPaid).not.toHaveBeenCalled();
        validate.mockRestore();
    });

    test("list and deactivate keep the code reserved", async () => {
        const created = await Coupons.createCoupon({ code: "listme", percentOff: 15, plans: ["unlimited"], maxRedemptions: 2 }, "admin@zelf.world");
        const listed = await Coupons.listCoupons();
        expect(listed.map((coupon) => coupon.code)).toContain("LISTME");
        const deactivated = await Coupons.deactivateCoupon(created.id);
        expect(deactivated.active).toBe(false);
        expect(deactivated.code).toBe("LISTME");
        expect(deactivated.redemptions).toEqual([]);
        await expect(Coupons.deactivateCoupon("missing-id")).rejects.toMatchObject({ clientCode: "coupon_not_found" });
    });
});
