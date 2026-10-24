/**
 * Confirm flows under a fixed process timezone. Invoked by zelf-id-confirm-tz.test.js
 * so moment loads after TZ is set.
 */
const mongoose = require("mongoose");
const moment = require("moment");
const jwt = require("jsonwebtoken");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { Domain } = require("../../Repositories/Tags/modules/domain.class");
const { zelfPlanLicenseData } = require("../fixtures/zelf-plan-license.fixture");
const { formatLeaseDate } = require("../../Repositories/Tags/modules/lease-date.util");

let domainConfig;

jest.mock("../../Repositories/Tags/modules/tag-smart-contract-payment.module", () => ({
    throwPaymentConfirmationTagNotFound: jest.fn((tagName, domain) => {
        throw new Error(`404:${tagName}.${domain}`);
    }),
    verifySmartContractPayment: jest.fn(),
}));

jest.mock("../../Repositories/Tags/modules/my-tags.module", () => ({
    confirmPayUniqueAddress: jest.fn(async () => ({ confirmed: true, amountReceived: 1 })),
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

const Coupon = require("../../Repositories/ZelfID/models/zelf-id-coupon.model");
const QuoteGrant = require("../../Repositories/ZelfID/models/zelf-id-quote-grant.model");
const Coupons = require("../../Repositories/ZelfID/modules/zelf-ids-coupons.module");
const { verifyPaymentConfirmation } = require("../../Repositories/ZelfID/modules/my-zelf-id.module");
const { confirmPaidStripeSession, buildLeaseStripeMetadata } = require("../../Repositories/ZelfID/modules/zelf-ids-stripe.module");
const ZelfIdModule = require("../../Repositories/ZelfID/modules/zelf-id.module");
const config = require("../../Core/config");
const Session = require("../../Repositories/Session/models/session.model");
const TagsModule = require("../../Repositories/Tags/modules/tags.module");

const license = () =>
    new Domain({
        ...zelfPlanLicenseData(),
        tags: {
            ...zelfPlanLicenseData().tags,
            payment: {
                ...zelfPlanLicenseData().tags.payment,
                whitelist: { "ref.zelf": "100%" },
            },
            storage: { keyPrefix: "tagName", ipfsEnabled: false, arweaveEnabled: false, walrusEnabled: false },
        },
    });

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
        registeredAt: formatLeaseDate(),
        expiresAt: formatLeaseDate(100, "year"),
        ...extra,
    },
});

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

const sign = (bare, extra = {}) =>
    jwt.sign(
        {
            tagName: `${bare}.zelf`,
            tagPayName: `${bare}.zelfpay`,
            plan: "premium",
            duration: 1,
            initiatedAt: moment().unix(),
            ttl: moment().add(2, "hour").unix(),
            ...extra,
        },
        config.JWT_SECRET
    );

const confirmDescribe = process.env.CONFIRM_TZ_CHILD === "1" ? describe : describe.skip;

confirmDescribe(`confirm under ${process.env.TZ || "default"}`, () => {
    let memory;
    let tags;

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
        await QuoteGrant.deleteMany({});
        tags = new Map();
        ZelfIdModule.searchTag.mockImplementation(async ({ tagName }) => {
            const bare = `${tagName}`.split(".")[0].toLowerCase();
            if (!tags.has(bare)) tags.set(bare, tagFor(bare));
            return { available: false, tagName: bare, tagObject: tags.get(bare), ipfs: [] };
        });
        TagsModule.decryptTag.mockReset();
        TagsModule.decryptTag.mockResolvedValue({});
    });

    test("coupon replay is idempotent and a failed identity check does not confirm", async () => {
        const created = await Coupons.createCoupon(
            { code: "tz100", percentOff: 100, plans: ["premium"], maxRedemptions: 2 },
            "admin@zelf.world"
        );
        const bare = "tzcoupon";
        const token = sign(bare, { freeCheckout: true, amountDue: 0, coupon: { id: created.id, code: created.code, valid: true } });

        await expect(verifyPaymentConfirmation(bare, "zelf", "FREE", token, {})).rejects.toMatchObject({
            clientCode: "ERR_IDENTITY_VERIFICATION_REQUIRED",
        });
        expect((await Coupon.findOne({ code: "TZ100" }).lean()).redemptions).toHaveLength(0);

        const owner = await allowOwner(bare);
        const granted = await verifyPaymentConfirmation(bare, "zelf", "FREE", token, owner);
        expect(granted.confirmed).toBe(true);
        expect(granted.cache).toBeUndefined();
        expect(granted.tagObject.publicData.duration).toBe("100");
        expect(granted.tagObject.publicData.registeredAt).toBe(tags.get(bare).publicData.registeredAt);

        const replay = await verifyPaymentConfirmation(bare, "zelf", "FREE", token, owner);
        expect(replay.cache).toBe(true);
        expect(replay.confirmed).toBe(true);
        expect((await Coupon.findOne({ code: "TZ100" }).lean()).redemptions).toHaveLength(1);

        const other = await allowOwner("someone");
        await expect(verifyPaymentConfirmation(bare, "zelf", "FREE", token, other)).rejects.toMatchObject({
            clientCode: "ERR_SESSION_OWNER_MISMATCH",
        });

        TagsModule.decryptTag.mockRejectedValueOnce(new Error("invalid password"));
        await expect(
            verifyPaymentConfirmation(bare, "zelf", "FREE", token, {
                authUser: { tagName: "someone", domain: "zelf" },
                faceBase64: "face",
                masterPassword: "wrong",
            })
        ).rejects.toMatchObject({ clientCode: "ERR_INVALID_PASSWORD" });
        expect((await Coupon.findOne({ code: "TZ100" }).lean()).redemptions).toHaveLength(1);
        expect(await QuoteGrant.countDocuments({ source: "coupon" })).toBe(1);
    });

    test("whitelist grant keeps the lease and replays only for the owner", async () => {
        const bare = "whitelistx";
        tags.set(bare, tagFor(bare, { referralTagName: "ref.zelf" }));
        const token = sign(bare, { freeCheckout: true, referralTagName: "ref.zelf" });
        const owner = await allowOwner(bare);

        await expect(verifyPaymentConfirmation(bare, "zelf", "FREE", token, {})).rejects.toMatchObject({
            clientCode: "ERR_IDENTITY_VERIFICATION_REQUIRED",
        });

        const granted = await verifyPaymentConfirmation(bare, "zelf", "FREE", token, owner);
        expect(granted.confirmed).toBe(true);
        expect(granted.paymentMethod).toBe("whitelist");
        expect(granted.cache).toBeUndefined();
        expect(granted.tagObject.publicData.duration).toBe("100");

        const replay = await verifyPaymentConfirmation(bare, "zelf", "FREE", token, owner);
        expect(replay.cache).toBe(true);
        expect(replay.confirmed).toBe(true);
        expect(await QuoteGrant.countDocuments({ source: "whitelist" })).toBe(1);
    });

    test("crypto confirm grants once and does not treat a UTC registeredAt as already renewed", async () => {
        const bare = "cryptotz1";
        const token = sign(bare, {
            prices: { ETH: { amountToSend: 0.01, price: 29 } },
            paymentAddress: { ethAddress: "0xabc" },
        });
        const first = await verifyPaymentConfirmation(bare, "zelf", "ETH", token, {});
        expect(first.confirmed).toBe(true);
        expect(first.cache).toBeUndefined();

        const replay = await verifyPaymentConfirmation(bare, "zelf", "ETH", token, {});
        expect(replay.cache).toBe(true);
        expect(replay.confirmed).toBe(true);

        const other = sign("othernam", {
            prices: { ETH: { amountToSend: 0.01, price: 29 } },
            paymentAddress: { ethAddress: "0xabc" },
        });
        await expect(verifyPaymentConfirmation(bare, "zelf", "ETH", other, {})).rejects.toThrow("403:tag_not_owned");
    });

    test("stripe confirm grants once for the session instead of the pin clock", async () => {
        const bare = "stripetz1";
        const session = {
            id: "cs_test_tz_session",
            payment_status: "paid",
            created: moment().subtract(5, "minutes").unix(),
            amount_total: 2900,
            metadata: buildLeaseStripeMetadata({
                tagName: bare,
                domain: "zelf",
                duration: "1",
                plan: "premium",
                amountUsd: 29,
            }),
        };

        const first = await confirmPaidStripeSession(session);
        expect(first.confirmed).toBe(true);
        expect(first.cache).toBeUndefined();
        expect(tags.get(bare).publicData.duration).toBe("100");

        const replay = await confirmPaidStripeSession(session);
        expect(replay.cache).toBe(true);
        expect(replay.confirmed).toBe(true);
        expect(replay.action).toBe("already_extended");
        expect(await QuoteGrant.countDocuments({ source: "stripe" })).toBe(1);
    });
});
