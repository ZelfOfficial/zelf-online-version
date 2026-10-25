/**
 * Premium → Unlimited upgrade credit.
 * Credit is the amount actually paid for the open Premium term, times the
 * fraction of that term still left, floored to the cent and capped at the
 * Unlimited price. Coupons apply after that credit.
 */
const mongoose = require("mongoose");
const moment = require("moment");
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

jest.mock("../../Repositories/Tags/modules/tags.module", () => ({
    decryptTag: jest.fn(async () => ({})),
}));

jest.mock("../../Repositories/Tags/config/supported-domains", () => ({
    getDomainConfig: () => domainConfig,
}));

jest.mock("../../Repositories/ZelfID/modules/zelf-id.module", () => ({
    searchTag: jest.fn(),
    _validateReferral: jest.fn(),
}));

jest.mock("../../Repositories/binance/modules/binance.module", () => ({
    getTickerPrice: jest.fn(async () => ({ price: "2000" })),
}));

jest.mock("stripe", () => {
    const create = jest.fn(async () => ({ id: "cs_upgrade", url: "https://checkout.stripe.test/c" }));
    const Stripe = jest.fn(() => ({ checkout: { sessions: { create } } }));
    Stripe.__create = create;
    return Stripe;
});

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
const PlanTerm = require("../../Repositories/ZelfID/models/zelf-id-plan-term.model");
const QuoteGrant = require("../../Repositories/ZelfID/models/zelf-id-quote-grant.model");
const Coupons = require("../../Repositories/ZelfID/modules/zelf-ids-coupons.module");
const { creditFromPaid, combineAmountPaid } = require("../../Repositories/ZelfID/modules/zelf-id-upgrade-credit.module");
const { getPaymentOptions } = require("../../Repositories/ZelfID/modules/zelf-ids-payment.module");
const { verifyPaymentConfirmation, addDurationToTag } = require("../../Repositories/ZelfID/modules/my-zelf-id.module");
const { createStripeCheckout } = require("../../Repositories/ZelfID/modules/zelf-ids-stripe.module");
const ZelfIdModule = require("../../Repositories/ZelfID/modules/zelf-id.module");
const config = require("../../Core/config");
const Session = require("../../Repositories/Session/models/session.model");
const Stripe = require("stripe");
const jwt = require("jsonwebtoken");
const { confirmPayUniqueAddress } = require("../../Repositories/Tags/modules/my-tags.module");

const licenseData = () => {
    const base = zelfPlanLicenseData();
    return {
        ...base,
        tags: {
            ...base.tags,
            payment: {
                ...base.tags.payment,
                networks: {
                    ethereum: { enabled: true, nativeCurrency: { enabled: true, code: "ETH" } },
                },
            },
            storage: { keyPrefix: "tagName", ipfsEnabled: false, arweaveEnabled: false, walrusEnabled: false },
        },
    };
};

const tagFor = (bare, extra = {}) => ({
    zelfProofQRCode: "qr",
    publicData: {
        tagName: `${bare}.zelf`,
        type: "mainnet",
        plan: "free",
        duration: "100",
        v: "4",
        origin: "online",
        hasPassword: "true",
        expiresAt: "2126-01-01 00:00:00",
        registeredAt: "2019-06-01 00:00:00",
        ...extra,
    },
});

const yearStamp = (from, years) => from.clone().add(years, "year").format("YYYY-MM-DD HH:mm:ss");

const halfwayFrom = (from) => {
    const end = from.clone().add(1, "year");
    const half = Math.round(end.diff(from, "seconds") / 2);
    return from.clone().add(half, "seconds").format("YYYY-MM-DD HH:mm:ss");
};

const allowOwner = async (bare) => {
    const session = await Session.create({
        identifier: `sess-${bare}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        clientIP: "127.0.0.1",
        domain: "zelf",
        isWebExtension: false,
        status: "active",
        type: "decryptWallet",
        tagName: bare,
        verifiedTagName: `${bare}.zelf`,
        verifiedAt: new Date(),
        verifiedUntil: new Date(Date.now() + 10 * 60 * 1000),
    });
    return { authUser: { session: String(session._id), tagName: bare, domain: "zelf" } };
};

describe("Premium to Unlimited upgrade credit", () => {
    let memory;
    const tags = new Map();

    beforeAll(async () => {
        if (!config.JWT_SECRET) config.JWT_SECRET = "test-jwt-secret-key-for-testing-only";
        config.stripe = { ...(config.stripe || {}), secretKey: "sk_test_upgrade_credit" };
        domainConfig = new Domain(licenseData());
        memory = await MongoMemoryServer.create();
        await mongoose.connect(memory.getUri());
    }, 180000);

    afterAll(async () => {
        await mongoose.disconnect();
        if (memory) await memory.stop();
    });

    beforeEach(async () => {
        tags.clear();
        Stripe.__create.mockClear();
        await Coupon.deleteMany({});
        await PlanTerm.deleteMany({});
        await QuoteGrant.deleteMany({});
        ZelfIdModule.searchTag.mockImplementation(async ({ tagName }) => {
            const bare = `${tagName}`.split(".")[0].toLowerCase();
            const record = tags.get(bare);
            if (!record) return { available: true, tagName: bare };
            return { available: false, tagName: bare, tagObject: record, ipfs: [] };
        });
    });

    test("half of a 1-year term is half the amount paid, floored to the cent and capped", () => {
        const end = moment.utc("2027-06-01 00:00:00", "YYYY-MM-DD HH:mm:ss");
        const start = end.clone().subtract(1, "year");
        const now = end.clone().subtract(end.diff(start, "seconds") / 2, "seconds");
        const planExpiresAt = end.format("YYYY-MM-DD HH:mm:ss");

        expect(creditFromPaid({ amountPaidUsd: 29, planExpiresAt, duration: "1", listPriceUsd: 99, now })).toBe(14.5);
        expect(creditFromPaid({ amountPaidUsd: 14.5, planExpiresAt, duration: "1y", listPriceUsd: 99, now })).toBe(7.25);
        expect(creditFromPaid({ amountPaidUsd: 500, planExpiresAt, duration: "1", listPriceUsd: 99, now })).toBe(99);
        expect(creditFromPaid({ amountPaidUsd: 29, planExpiresAt, duration: "lifetime", listPriceUsd: 99, now })).toBe(0);
        expect(creditFromPaid({ amountPaidUsd: 0, planExpiresAt, duration: "1", listPriceUsd: 99, now })).toBe(0);
    });

    test("a halfway Premium term paid $29 credits about $14.50", async () => {
        const bare = "halfway";
        const planExpiresAt = halfwayFrom(moment.utc());
        tags.set(bare, tagFor(bare, { plan: "premium", planExpiresAt, planDuration: "1" }));
        await PlanTerm.create({
            zelfName: `${bare}.zelf`,
            plan: "premium",
            planExpiresAt,
            paymentMethod: "stripe",
            duration: "1",
            amountPaidUsd: 29,
        });

        const quote = await getPaymentOptions(bare, "zelf", "1", {}, { requestedPlan: "unlimited" });

        expect(quote.listPriceUsd).toBe(99);
        expect(quote.listPrice).toBe(99);
        expect(quote.upgradeCreditUsd).toBeCloseTo(14.5, 1);
        expect(quote.upgradeCredit).toBe(quote.upgradeCreditUsd);
        expect(quote.amountDue).toBeCloseTo(99 - quote.upgradeCreditUsd, 2);
        expect(quote.billableUsdPrice).toBe(quote.amountDue);
        expect(quote.prices.ETH.price).toBe(quote.billableUsdPrice);
        expect(quote.freeCheckout).toBe(false);
        const signed = require("jsonwebtoken").verify(quote.signedDataPrice, config.JWT_SECRET);
        expect(signed.upgradeCreditUsd).toBe(quote.upgradeCreditUsd);
        expect(signed.amountDue).toBe(quote.amountDue);
    });

    test("a 100% coupon Premium credits nothing", async () => {
        const bare = "compfree";
        const planExpiresAt = halfwayFrom(moment.utc());
        await Coupons.createCoupon({ code: "fullprem", percentOff: 100, plans: ["premium"], maxRedemptions: 5 }, "admin@zelf.world");
        await Coupon.updateOne(
            { code: "FULLPREM" },
            {
                $push: {
                    redemptions: { zelfId: `${bare}.zelf`, plan: "premium", duration: "1y", redeemedAt: new Date(), key: "k1" },
                },
            }
        );
        tags.set(bare, tagFor(bare, { plan: "premium", planExpiresAt, planDuration: "1", paymentMethod: "coupon" }));
        await PlanTerm.create({
            zelfName: `${bare}.zelf`,
            plan: "premium",
            planExpiresAt,
            paymentMethod: "coupon",
            duration: "1",
        });

        const spy = jest.spyOn(console, "info").mockImplementation(() => {});
        const quote = await getPaymentOptions(bare, "zelf", "1", {}, { requestedPlan: "unlimited" });
        const unknown = spy.mock.calls.filter((call) => call[0] === "[zelf-id-upgrade-credit] amount_paid_unknown");
        spy.mockRestore();

        expect(quote.upgradeCreditUsd).toBe(0);
        expect(quote.amountDue).toBe(99);
        expect(unknown).toHaveLength(0);
    });

    test("a 50% coupon credits half of what was paid", async () => {
        const bare = "halfpay";
        const planExpiresAt = halfwayFrom(moment.utc());
        tags.set(bare, tagFor(bare, { plan: "premium", planExpiresAt, planDuration: "1", paymentMethod: "stripe" }));
        await PlanTerm.create({
            zelfName: `${bare}.zelf`,
            plan: "premium",
            planExpiresAt,
            paymentMethod: "stripe",
            duration: "1",
            amountPaidUsd: 14.5,
        });

        const quote = await getPaymentOptions(bare, "zelf", "1", {}, { requestedPlan: "unlimited" });

        expect(quote.upgradeCreditUsd).toBeCloseTo(7.25, 1);
        expect(quote.upgradeCreditUsd).toBeLessThan(14.5);
    });

    test("a Premium term paid from the start uses the name lease as the term", async () => {
        const bare = "paidstart";
        const expiresAt = halfwayFrom(moment.utc());
        tags.set(bare, tagFor(bare, { plan: "premium", duration: "1", expiresAt }));
        await PlanTerm.create({
            zelfName: `${bare}.zelf`,
            plan: "premium",
            paymentMethod: "stripe",
            amountPaidUsd: 29,
        });

        const quote = await getPaymentOptions(bare, "zelf", "1", {}, { requestedPlan: "unlimited" });

        expect(quote.upgradeCreditUsd).toBeCloseTo(14.5, 1);
        expect(quote.amountDue).toBeCloseTo(99 - quote.upgradeCreditUsd, 2);
    });

    test("a lapsed Premium term credits nothing", async () => {
        const bare = "lapsedup";
        const planExpiresAt = moment.utc().subtract(2, "day").format("YYYY-MM-DD HH:mm:ss");
        tags.set(bare, tagFor(bare, { plan: "premium", planExpiresAt, planDuration: "1" }));
        await PlanTerm.create({
            zelfName: `${bare}.zelf`,
            plan: "premium",
            planExpiresAt,
            paymentMethod: "stripe",
            duration: "1",
            amountPaidUsd: 29,
        });

        const quote = await getPaymentOptions(bare, "zelf", "1", {}, { requestedPlan: "unlimited" });

        expect(quote.upgradeCreditUsd).toBe(0);
        expect(quote.amountDue).toBe(99);
        expect(quote.plan).toBe("unlimited");
    });

    test("an older Premium term with no payment record credits 0 and logs it", async () => {
        const bare = "unknownpay";
        const planExpiresAt = halfwayFrom(moment.utc());
        tags.set(bare, tagFor(bare, { plan: "premium", planExpiresAt, planDuration: "1", paymentMethod: "stripe" }));
        await PlanTerm.create({
            zelfName: `${bare}.zelf`,
            plan: "premium",
            planExpiresAt,
            paymentMethod: "stripe",
            duration: "1",
        });

        const spy = jest.spyOn(console, "info").mockImplementation(() => {});
        const quote = await getPaymentOptions(bare, "zelf", "1", {}, { requestedPlan: "unlimited" });
        const unknown = spy.mock.calls.filter((call) => call[0] === "[zelf-id-upgrade-credit] amount_paid_unknown");
        spy.mockRestore();

        expect(quote.upgradeCreditUsd).toBe(0);
        expect(quote.amountDue).toBe(99);
        expect(unknown).toEqual([["[zelf-id-upgrade-credit] amount_paid_unknown", { zelfName: `${bare}.zelf` }]]);
    });

    test("a coupon applies after the credit, and a zero total uses the free path", async () => {
        const bare = "creditoff";
        const planExpiresAt = halfwayFrom(moment.utc());
        tags.set(bare, tagFor(bare, { plan: "premium", planExpiresAt, planDuration: "1" }));
        await PlanTerm.create({
            zelfName: `${bare}.zelf`,
            plan: "premium",
            planExpiresAt,
            paymentMethod: "stripe",
            duration: "1",
            amountPaidUsd: 29,
        });
        await Coupons.createCoupon({ code: "halfunl", percentOff: 50, plans: ["unlimited"], maxRedemptions: 5 }, "admin@zelf.world");
        const partial = await getPaymentOptions(bare, "zelf", "1", {}, { requestedPlan: "unlimited", coupon: "halfunl" });
        expect(partial.coupon.valid).toBe(true);
        expect(partial.amountDue).toBe(Coupons.amountDueFor(partial.listPrice - partial.upgradeCredit, 50));
        expect(partial.amountDue).toBeGreaterThan(0);
        expect(partial.freeCheckout).toBe(false);
        expect(partial.prices.ETH.price).toBe(partial.amountDue);

        await Coupons.createCoupon({ code: "allunl", percentOff: 100, plans: ["unlimited"], maxRedemptions: 5 }, "admin@zelf.world");
        const freeQuote = await getPaymentOptions(bare, "zelf", "1", {}, { requestedPlan: "unlimited", coupon: "allunl" });
        expect(freeQuote.upgradeCreditUsd).toBe(partial.upgradeCreditUsd);
        expect(freeQuote.amountDue).toBe(0);
        expect(freeQuote.freeCheckout).toBe(true);
        expect(freeQuote.billableUsdPrice).toBe(0);

        const identity = await allowOwner(bare);
        const granted = await verifyPaymentConfirmation(bare, "zelf", "FREE", freeQuote.signedDataPrice, identity);
        expect(granted.confirmed).toBe(true);
        expect(granted.paymentMethod).toBe("coupon");
        expect(Stripe.__create).not.toHaveBeenCalled();
        const stored = await PlanTerm.findOne({ zelfName: `${bare}.zelf` }).lean();
        expect(stored.plan).toBe("unlimited");
        expect(stored.amountPaidUsd).toBe(0);
        expect(stored.duration).toBe("1");
    });

    test("confirm rejects a signed credit that no longer matches", async () => {
        const bare = "mismatch";
        const planExpiresAt = halfwayFrom(moment.utc());
        tags.set(bare, tagFor(bare, { plan: "premium", planExpiresAt, planDuration: "1" }));
        await PlanTerm.create({
            zelfName: `${bare}.zelf`,
            plan: "premium",
            planExpiresAt,
            paymentMethod: "stripe",
            duration: "1",
            amountPaidUsd: 29,
        });
        const created = await Coupons.createCoupon(
            { code: "mismatch100", percentOff: 100, plans: ["unlimited"], maxRedemptions: 5 },
            "admin@zelf.world"
        );
        const quote = await getPaymentOptions(bare, "zelf", "1", {}, { requestedPlan: "unlimited", coupon: "mismatch100" });
        expect(quote.upgradeCreditUsd).toBeGreaterThan(1);
        expect(quote.freeCheckout).toBe(true);

        await expect(verifyPaymentConfirmation(bare, "zelf", "FREE", quote.signedDataPrice, {})).rejects.toThrow(/ERR_IDENTITY_VERIFICATION_REQUIRED/);

        const lapsed = moment.utc().subtract(3, "day").format("YYYY-MM-DD HH:mm:ss");
        tags.get(bare).publicData.planExpiresAt = lapsed;
        await PlanTerm.updateOne({ zelfName: `${bare}.zelf` }, { $set: { planExpiresAt: lapsed } });
        const identity = await allowOwner(bare);

        await expect(verifyPaymentConfirmation(bare, "zelf", "FREE", quote.signedDataPrice, identity)).rejects.toMatchObject({
            message: "409:upgrade_term_changed",
            clientCode: "upgrade_term_changed",
        });

        const saved = await Coupon.findOne({ code: created.code }).lean();
        expect(saved.redemptions).toHaveLength(0);
        const pending = await QuoteGrant.findOne({ zelfName: `${bare}.zelf`, status: "pending" }).lean();
        expect(pending).toBeNull();
    });

    test("a valid quote keeps its locked credit when the clock would move the cent", async () => {
        const bare = "lockedcr";
        const planExpiresAt = halfwayFrom(moment.utc());
        tags.set(bare, tagFor(bare, { plan: "premium", planExpiresAt, planDuration: "1" }));
        await PlanTerm.create({
            zelfName: `${bare}.zelf`,
            plan: "premium",
            planExpiresAt,
            paymentMethod: "stripe",
            duration: "1",
            amountPaidUsd: 29,
        });
        await Coupons.createCoupon({ code: "lock100", percentOff: 100, plans: ["unlimited"], maxRedemptions: 3 }, "admin@zelf.world");
        const quote = await getPaymentOptions(bare, "zelf", "1", {}, { requestedPlan: "unlimited", coupon: "lock100" });
        const decoded = jwt.verify(quote.signedDataPrice, config.JWT_SECRET);
        decoded.upgradeCreditUsd = 1;
        decoded.upgradeCredit = 1;
        const resigned = jwt.sign(decoded, config.JWT_SECRET);
        const identity = await allowOwner(bare);
        const granted = await verifyPaymentConfirmation(bare, "zelf", "FREE", resigned, identity);
        expect(granted.confirmed).toBe(true);
        expect(granted.paymentMethod).toBe("coupon");
    });

    test("an expired quote is rejected", async () => {
        const bare = "expiredq";
        tags.set(bare, tagFor(bare));
        const token = jwt.sign(
            {
                tagName: `${bare}.zelf`,
                tagPayName: `${bare}.zelfpay`,
                plan: "premium",
                duration: 1,
                ttl: moment().subtract(1, "minute").unix(),
                freeCheckout: true,
                amountDue: 0,
                billableUsdPrice: 0,
            },
            config.JWT_SECRET
        );
        await expect(verifyPaymentConfirmation(bare, "zelf", "FREE", token, {})).rejects.toThrow(/token_expired/);
    });

    test("a different plan term is rejected before crypto payment", async () => {
        const bare = "termswap";
        const planExpiresAt = halfwayFrom(moment.utc());
        tags.set(bare, tagFor(bare, { plan: "premium", planExpiresAt, planDuration: "1" }));
        await PlanTerm.create({
            zelfName: `${bare}.zelf`,
            plan: "premium",
            planExpiresAt,
            paymentMethod: "stripe",
            duration: "1",
            amountPaidUsd: 29,
        });
        const quote = await getPaymentOptions(bare, "zelf", "1", {}, { requestedPlan: "unlimited" });
        const lapsed = moment.utc().subtract(2, "day").format("YYYY-MM-DD HH:mm:ss");
        tags.get(bare).publicData.planExpiresAt = lapsed;
        await PlanTerm.updateOne({ zelfName: `${bare}.zelf` }, { $set: { planExpiresAt: lapsed } });
        confirmPayUniqueAddress.mockClear();

        await expect(verifyPaymentConfirmation(bare, "zelf", "ETH", quote.signedDataPrice, {})).rejects.toMatchObject({
            clientCode: "upgrade_term_changed",
        });
        expect(confirmPayUniqueAddress).not.toHaveBeenCalled();
    });

    test("stripe checkout expires with the quote and refuses one that is almost over", async () => {
        const bare = "stripewin";
        const planExpiresAt = halfwayFrom(moment.utc());
        tags.set(bare, tagFor(bare, { plan: "premium", planExpiresAt, planDuration: "1" }));
        await PlanTerm.create({
            zelfName: `${bare}.zelf`,
            plan: "premium",
            planExpiresAt,
            paymentMethod: "stripe",
            duration: "1",
            amountPaidUsd: 29,
        });
        const quote = await getPaymentOptions(bare, "zelf", "1", {}, { requestedPlan: "unlimited" });
        const decoded = jwt.verify(quote.signedDataPrice, config.JWT_SECRET);
        Stripe.__create.mockClear();
        await createStripeCheckout({
            tagName: bare,
            domain: "zelf",
            duration: "1",
            plan: "unlimited",
            token: quote.signedDataPrice,
        });
        expect(Stripe.__create.mock.calls[0][0].expires_at).toBe(decoded.ttl);

        decoded.ttl = moment().add(10, "minutes").unix();
        await expect(
            createStripeCheckout({
                tagName: bare,
                domain: "zelf",
                duration: "1",
                plan: "unlimited",
                token: jwt.sign(decoded, config.JWT_SECRET),
            })
        ).rejects.toMatchObject({ clientCode: "quote_expiring" });
    });

    test("an unlimited lifetime name is not quoted", async () => {
        const bare = "lifename";
        tags.set(bare, tagFor(bare, { plan: "unlimited", duration: "lifetime", planDuration: "lifetime" }));
        await expect(getPaymentOptions(bare, "zelf", "1", {}, { requestedPlan: "unlimited" })).rejects.toMatchObject({
            clientCode: "already_lifetime",
            clientMessage: "plan_not_upgradable",
        });
    });

    test("a dev fee fraction does not turn a positive total into a free checkout", async () => {
        const bare = "devfeeaa";
        tags.set(bare, tagFor(bare));
        const previousEnv = config.env;
        const previousFraction = process.env.TAG_PAY_DEV_AMOUNT_FRACTION;
        const previousAuto = process.env.TAG_PAY_DEV_AUTO_REDUCED_FEE;
        config.env = "development";
        process.env.TAG_PAY_DEV_AMOUNT_FRACTION = "0.00001";
        process.env.TAG_PAY_DEV_AUTO_REDUCED_FEE = "true";
        try {
            const quote = await getPaymentOptions(bare, "zelf", "1", {}, { requestedPlan: "premium" });
            expect(quote.billableUsdPrice).toBeGreaterThanOrEqual(0.01);
            expect(quote.freeCheckout).toBe(false);
        } finally {
            config.env = previousEnv;
            if (previousFraction === undefined) delete process.env.TAG_PAY_DEV_AMOUNT_FRACTION;
            else process.env.TAG_PAY_DEV_AMOUNT_FRACTION = previousFraction;
            if (previousAuto === undefined) delete process.env.TAG_PAY_DEV_AUTO_REDUCED_FEE;
            else process.env.TAG_PAY_DEV_AUTO_REDUCED_FEE = previousAuto;
        }
    });

    test("a small positive total after credit is rejected by Stripe and still quoted for crypto", async () => {
        const bare = "smalldue";
        const planExpiresAt = yearStamp(moment.utc(), 1);
        tags.set(bare, tagFor(bare, { plan: "premium", planExpiresAt, planDuration: "1" }));
        await PlanTerm.create({
            zelfName: `${bare}.zelf`,
            plan: "premium",
            planExpiresAt,
            paymentMethod: "stripe",
            duration: "1",
            amountPaidUsd: 98.6,
        });

        const quote = await getPaymentOptions(bare, "zelf", "1", {}, { requestedPlan: "unlimited" });
        expect(quote.billableUsdPrice).toBeGreaterThan(0);
        expect(quote.billableUsdPrice).toBeLessThan(0.5);
        expect(quote.freeCheckout).toBe(false);
        expect(quote.prices.ETH.price).toBe(quote.billableUsdPrice);
        expect(quote.prices.ETH.price).not.toBe(quote.listPriceUsd);

        await expect(
            createStripeCheckout({
                tagName: bare,
                domain: "zelf",
                duration: "1",
                plan: "unlimited",
                token: quote.signedDataPrice,
            })
        ).rejects.toMatchObject({ clientCode: "stripe_amount_below_minimum" });
        expect(Stripe.__create).not.toHaveBeenCalled();
    });

    test("the amount paid is stored on the plan term and replaced when the plan changes", async () => {
        expect(
            combineAmountPaid({ previousPlan: "premium", previousAmount: 14.5, nextPlan: "premium", charged: 14.5 })
        ).toBe(29);
        expect(
            combineAmountPaid({ previousPlan: "premium", previousAmount: 29, nextPlan: "unlimited", charged: 84.5 })
        ).toBe(84.5);
        expect(combineAmountPaid({ previousPlan: null, previousAmount: null, nextPlan: "premium", charged: 0 })).toBe(0);

        const bare = "storepay";
        const tag = tagFor(bare);
        await addDurationToTag(
            {
                tagName: bare,
                price: 14.5,
                billableUsdPrice: 14.5,
                domain: "zelf",
                duration: 1,
                plan: "premium",
                domainConfig,
                paymentMethod: "stripe",
            },
            tag
        );
        let stored = await PlanTerm.findOne({ zelfName: `${bare}.zelf` }).lean();
        expect(stored.amountPaidUsd).toBe(14.5);
        expect(stored.plan).toBe("premium");
        expect(stored.termStartedAt).toBeInstanceOf(Date);
        const originalStart = new Date("2024-01-01T00:00:00.000Z");
        await PlanTerm.updateOne({ zelfName: `${bare}.zelf` }, { $set: { termStartedAt: originalStart } });

        await addDurationToTag(
            {
                tagName: bare,
                price: 14.5,
                billableUsdPrice: 14.5,
                domain: "zelf",
                duration: 1,
                plan: "premium",
                domainConfig,
                paymentMethod: "stripe",
            },
            tag
        );
        stored = await PlanTerm.findOne({ zelfName: `${bare}.zelf` }).lean();
        expect(stored.amountPaidUsd).toBe(29);
        expect(new Date(stored.termStartedAt).toISOString()).toBe(originalStart.toISOString());

        await addDurationToTag(
            {
                tagName: bare,
                price: 84.5,
                billableUsdPrice: 84.5,
                domain: "zelf",
                duration: 1,
                plan: "unlimited",
                domainConfig,
                paymentMethod: "stripe",
            },
            tag
        );
        stored = await PlanTerm.findOne({ zelfName: `${bare}.zelf` }).lean();
        expect(stored.plan).toBe("unlimited");
        expect(stored.amountPaidUsd).toBe(84.5);
        expect(new Date(stored.termStartedAt).toISOString()).not.toBe(originalStart.toISOString());
    });

    test("a finished crypto grant replays after the quote expires", async () => {
        const bare = "replaylate";
        tags.set(bare, tagFor(bare));
        const now = Date.now();
        const clock = jest.spyOn(Date, "now").mockReturnValue(now);
        const live = jwt.sign(
            {
                tagName: `${bare}.zelf`,
                tagPayName: `${bare}.zelfpay`,
                plan: "premium",
                duration: 1,
                ttl: Math.floor(now / 1000) + 60,
                prices: { ETH: { price: 29, amountToSend: 0.01 } },
                paymentAddress: { ethAddress: "0xabc" },
            },
            config.JWT_SECRET
        );
        confirmPayUniqueAddress.mockResolvedValue({ confirmed: true, amountReceived: 0.01, paidAt: Math.floor(now / 1000) });
        const first = await verifyPaymentConfirmation(bare, "zelf", "ETH", live, {});
        expect(first.confirmed).toBe(true);
        expect(first.cache).toBeUndefined();

        clock.mockReturnValue(now + 5 * 60 * 1000);
        confirmPayUniqueAddress.mockClear();
        const replay = await verifyPaymentConfirmation(bare, "zelf", "ETH", live, {});
        clock.mockRestore();
        expect(replay.cache).toBe(true);
        expect(replay.confirmed).toBe(true);
        expect(confirmPayUniqueAddress).not.toHaveBeenCalled();
    });

    test("crypto paid before quote expiry is granted after expiry, and a later payment is not", async () => {
        const bare = "paidontime";
        tags.set(bare, tagFor(bare));
        const ttl = moment().subtract(1, "minute").unix();
        const token = jwt.sign(
            {
                tagName: `${bare}.zelf`,
                tagPayName: `${bare}.zelfpay`,
                plan: "premium",
                duration: 1,
                ttl,
                prices: { ETH: { price: 29, amountToSend: 0.01 } },
                paymentAddress: { ethAddress: "0xabc" },
            },
            config.JWT_SECRET
        );
        confirmPayUniqueAddress.mockResolvedValue({
            confirmed: true,
            amountReceived: 0.01,
            paidAt: ttl - 30,
        });
        const granted = await verifyPaymentConfirmation(bare, "zelf", "ETH", token, {});
        expect(granted.confirmed).toBe(true);
        expect(granted.cache).toBeUndefined();

        const late = "paidlate1";
        tags.set(late, tagFor(late));
        const lateToken = jwt.sign(
            {
                tagName: `${late}.zelf`,
                tagPayName: `${late}.zelfpay`,
                plan: "premium",
                duration: 1,
                ttl,
                prices: { ETH: { price: 29, amountToSend: 0.01 } },
                paymentAddress: { ethAddress: "0xabc" },
            },
            config.JWT_SECRET
        );
        confirmPayUniqueAddress.mockResolvedValue({
            confirmed: true,
            amountReceived: 0.01,
            paidAt: moment().unix(),
        });
        await expect(verifyPaymentConfirmation(late, "zelf", "ETH", lateToken, {})).rejects.toMatchObject({
            clientCode: "token_expired",
        });
    });

    test("a one-cent dev quote is below the Stripe minimum", async () => {
        const bare = "centquote";
        tags.set(bare, tagFor(bare));
        const token = jwt.sign(
            {
                tagName: `${bare}.zelf`,
                tagPayName: `${bare}.zelfpay`,
                plan: "premium",
                duration: 1,
                ttl: moment().add(2, "hour").unix(),
                billableUsdPrice: 0.01,
                amountDue: 0.01,
                prices: { ETH: { price: 0.01, amountToSend: 0.00001 } },
                devPaymentAmountDiscount: { fraction: 0.00001, billableUsdPrice: 0.01, listPriceUsd: 29 },
                upgradeCreditUsd: 0,
            },
            config.JWT_SECRET
        );
        await expect(
            createStripeCheckout({ tagName: bare, domain: "zelf", duration: "1", plan: "premium", token })
        ).rejects.toMatchObject({ clientCode: "stripe_amount_below_minimum" });
    });
});
