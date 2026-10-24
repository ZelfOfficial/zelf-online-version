jest.mock("../../Repositories/ZelfNameService/modules/zns-transaction-detector.module", () => ({
    getZNSBalance: jest.fn(),
}));

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const config = require("../../Core/config");
const { Domain } = require("../../Repositories/Tags/modules/domain.class");
const { errorHandler } = require("../../Core/http-handler");
const SlotAccount = require("../../Repositories/ZelfKeys/models/zelf-key-slot-account.model");
const PlanLimits = require("../../Repositories/ZelfKeys/modules/zelf-key-plan-limits.module");
const Middleware = require("../../Repositories/ZelfKeys/middlewares/zelf-key.middleware");
const Session = require("../../Repositories/Session/models/session.model");
const SessionModule = require("../../Repositories/Session/modules/session.module");
const { normalizeZelfName } = require("../../Repositories/Tags/modules/zelf-name.util");
const ZnsBalance = require("../../Repositories/ZelfNameService/modules/zns-transaction-detector.module");

jest.setTimeout(120000);

const alice = { tagName: "alice", identifier: "device-fingerprint-abc", domain: "zelf" };
const purchaseOptions = { plan: "free", balance: 100, domainConfig: null, now: "2026-01-15T00:00:00.000Z" };

let memoryServer;
let originalPrice;

const detailsOf = async (run) => {
    try {
        await run();
    } catch (error) {
        return { error, handled: errorHandler(error) };
    }
    throw new Error("expected the call to throw");
};

beforeAll(async () => {
    originalPrice = config.token.priceUsd;
    memoryServer = await MongoMemoryServer.create();
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    await mongoose.connect(memoryServer.getUri());
    await SlotAccount.init();
});

afterAll(async () => {
    config.token.priceUsd = originalPrice;
    await mongoose.disconnect();
    if (memoryServer) await memoryServer.stop();
});

beforeEach(async () => {
    config.token.priceUsd = 0.05;
    await SlotAccount.deleteMany({});
});

describe("Zelf Keys plan limits", () => {
    test.each([
        ["free", "password", 5, 4, true],
        ["free", "password", 5, 5, false],
        ["free", "zotp", 3, 2, true],
        ["free", "zotp", 3, 3, false],
        ["premium", "password", 100, 99, true],
        ["premium", "password", 100, 100, false],
        ["premium", "zotp", 20, 19, true],
        ["premium", "zotp", 20, 20, false],
        ["unlimited", "password", null, 10000, true],
        ["unlimited", "zotp", null, 10000, true],
    ])("%s %s limit %s used %s allowed %s", (plan, kind, limit, used, allowed) => {
        const decision = PlanLimits.evaluateLimit({ plan, kind, used, slots: [] });
        expect(decision.planLimit).toBe(limit);
        expect(decision.limit).toBe(limit);
        expect(decision.allowed).toBe(allowed);
        expect(decision.plan).toBe(plan);
        expect(decision.kind).toBe(kind);
    });

    test("a domain license planLimits entry replaces only the fields it sets", () => {
        const domainConfig = {
            zelfkeys: { planLimits: { free: { passwords: 1 }, premium: { zotp: 4 } } },
        };
        const blocked = PlanLimits.evaluateLimit({ plan: "free", kind: "password", used: 1, slots: [], domainConfig });
        const zotpStillFreeDefault = PlanLimits.evaluateLimit({ plan: "free", kind: "zotp", used: 3, slots: [], domainConfig });
        const premiumZotp = PlanLimits.evaluateLimit({ plan: "premium", kind: "zotp", used: 4, slots: [], domainConfig });

        expect(blocked.allowed).toBe(false);
        expect(blocked.limit).toBe(1);
        expect(zotpStillFreeDefault.limit).toBe(3);
        expect(premiumZotp.allowed).toBe(false);
        expect(premiumZotp.limit).toBe(4);
        expect(PlanLimits.limitsForPlan("premium", domainConfig).passwords).toBe(100);
    });

    test("a matching zelfkeys.plans row can cap a plan, and null means unlimited", () => {
        const domainConfig = {
            zelfkeys: {
                plans: [{ code: "unlimited", limits: { passwords: 2, zotp: null } }],
            },
        };
        expect(PlanLimits.evaluateLimit({ plan: "unlimited", kind: "password", used: 2, domainConfig }).allowed).toBe(false);
        expect(PlanLimits.evaluateLimit({ plan: "unlimited", kind: "zotp", used: 50, domainConfig }).limit).toBeNull();
    });

    test("Domain keeps zelfkeys.planLimits and does not treat limits.zelfkeys as a password cap", () => {
        const domain = new Domain({
            name: "acme",
            limits: { zelfkeys: 7 },
            zelfkeys: { planLimits: { free: { passwords: 2, zotp: 1 } } },
        });
        expect(domain.limits.zelfkeys).toBe(7);
        expect(domain.zelfkeys.planLimits.free).toEqual({ passwords: 2, zotp: 1 });
        expect(PlanLimits.limitsForPlan("free", domain).passwords).toBe(2);
    });

    test("an edit of an existing item is allowed at the cap", () => {
        const decision = PlanLimits.evaluateLimit({ plan: "free", kind: "password", used: 5, slots: [], isUpdate: true });
        expect(decision.allowed).toBe(true);
        expect(PlanLimits.isItemUpdate("password", { id: "pw-1" }, [{ id: "pw-1" }])).toBe(true);
        expect(PlanLimits.isItemUpdate("password", { website: "https://same.example", username: "a" }, [{ id: "pw-1", publicData: { website: "https://same.example", username: "a" } }])).toBe(false);
    });

    test("edit reference precedence is id, then cid, then recordId", () => {
        const items = [
            { id: "id-1", cid: "cid-1" },
            { id: "id-2", cid: "cid-2" },
        ];

        expect(PlanLimits.editReference({ id: "id-1", cid: "cid-2", recordId: "id-2" })).toEqual({ field: "id", value: "id-1" });
        expect(PlanLimits.editReference({ cid: "cid-2", recordId: "id-1" })).toEqual({ field: "cid", value: "cid-2" });
        expect(PlanLimits.editReference({ recordId: "id-2" })).toEqual({ field: "recordId", value: "id-2" });

        expect(PlanLimits.findEditTarget("password", { id: "id-1", cid: "cid-2", recordId: "id-2" }, items).id).toBe("id-1");
        expect(PlanLimits.findEditTarget("password", { cid: "cid-2", recordId: "id-1" }, items).id).toBe("id-2");
        expect(PlanLimits.findEditTarget("password", { id: "missing", cid: "cid-1" }, items)).toBeNull();
        expect(PlanLimits.findEditTarget("zotp", { recordId: "cid-1" }, items).id).toBe("id-1");
    });

    test("expired extra slots do not raise the cap and are not removed", () => {
        const slots = [
            {
                slotId: "old",
                kind: "password",
                purchasedAt: "2024-01-15T00:00:00.000Z",
                expiresAt: "2025-01-15T00:00:00.000Z",
                tokenCost: 10,
            },
        ];
        const decision = PlanLimits.evaluateLimit({
            plan: "free",
            kind: "password",
            used: 5,
            slots,
            now: "2026-02-01T00:00:00.000Z",
        });
        expect(decision.extraSlots).toBe(0);
        expect(decision.allowed).toBe(false);
        expect(decision.limit).toBe(5);
        expect(slots).toHaveLength(1);
    });

    test("an active extra slot raises the cap by one", () => {
        const decision = PlanLimits.evaluateLimit({
            plan: "free",
            kind: "password",
            used: 5,
            now: "2026-06-01T00:00:00.000Z",
            slots: [
                {
                    slotId: "live",
                    kind: "password",
                    purchasedAt: "2026-01-15T00:00:00.000Z",
                    expiresAt: "2027-01-15T00:00:00.000Z",
                    tokenCost: 10,
                },
            ],
        });
        expect(decision.extraSlots).toBe(1);
        expect(decision.limit).toBe(6);
        expect(decision.allowed).toBe(true);
        expect(decision.activeExtraSlots[0].expiresAt).toBe("2027-01-15T00:00:00.000Z");
    });

    test("expired paid Zelf ID reads as free; an empty record does not inherit a paid plan", () => {
        expect(
            PlanLimits.vaultPlanFromTag(
                { plan: "premium", type: "mainnet", zelfName: "alice.zelf", expiresAt: "2000-01-01 00:00:00" },
                null,
            ),
        ).toBe("free");
        expect(PlanLimits.vaultPlanFromTag({}, null)).toBe("free");
        expect(PlanLimits.vaultPlanFromTag({ plan: "unlimited", type: "mainnet", zelfName: "alice.zelf" }, null)).toBe("unlimited");
    });

    test("legacy keys entitlements do not change the consumer plan; premium and unlimited do", () => {
        expect(PlanLimits.applySubscriptionPlan("free", { plan: "pro" })).toBe("free");
        expect(PlanLimits.applySubscriptionPlan("free", { plan: "basic" })).toBe("free");
        expect(PlanLimits.applySubscriptionPlan("free", { revenueCatData: { plan: "premium" } })).toBe("premium");
        expect(PlanLimits.applySubscriptionPlan("premium", "unlimited")).toBe("unlimited");
        expect(PlanLimits.applySubscriptionPlan("unlimited", "premium")).toBe("unlimited");
    });
});

describe("Zelf Keys extra-slot token price", () => {
    test("0.05 USD per token is 10 ZNS per password slot and 20 per 2FA slot", () => {
        config.token.priceUsd = 0.05;
        expect(PlanLimits.slotTokenCost("password")).toBe(10);
        expect(PlanLimits.slotTokenCost("zotp")).toBe(20);
        expect(PlanLimits.slotTokenCost("2fa")).toBe(20);
    });

    test("0.10 USD per token is 5 ZNS per password slot and 10 per 2FA slot", () => {
        config.token.priceUsd = 0.1;
        expect(PlanLimits.slotTokenCost("password")).toBe(5);
        expect(PlanLimits.slotTokenCost("zotp")).toBe(10);
    });

    test("a price that does not divide the USD target ceils", () => {
        config.token.priceUsd = 0.03;
        expect(PlanLimits.slotTokenCost("password")).toBe(17);
        expect(PlanLimits.slotTokenCost("zotp")).toBe(34);
    });
});

describe("Zelf Keys extra-slot purchase", () => {
    const buy = (overrides = {}, user = alice) =>
        PlanLimits.purchaseExtraSlot(
            { kind: "password", idempotencyKey: "idem-alice-1", tagName: "mallory.zelf", ...overrides.body },
            user,
            { ...purchaseOptions, ...overrides.options },
        );

    test("mixed-case tag names share one slot account", async () => {
        const first = await PlanLimits.purchaseExtraSlot({ kind: "password", idempotencyKey: "idem-jim-1" }, { tagName: "JimBot", domain: "zelf" }, {
            plan: "free",
            balance: 30,
            domainConfig: null,
            now: "2026-01-15T00:00:00.000Z",
        });
        const second = await PlanLimits.purchaseExtraSlot({ kind: "password", idempotencyKey: "idem-jim-2" }, { tagName: "Jimbot.Zelf", domain: "Zelf" }, {
            plan: "free",
            balance: 30,
            domainConfig: null,
            now: "2026-01-15T00:00:00.000Z",
        });
        const accounts = await SlotAccount.find({}).lean();

        expect(first.zelfName).toBe("jimbot.zelf");
        expect(second.zelfName).toBe("jimbot.zelf");
        expect(accounts).toHaveLength(1);
        expect(accounts[0].spent).toBe(20);
    });

    test("debits the authenticated Zelf identity and ignores a tag name in the body", async () => {
        const result = await buy();
        const account = await SlotAccount.findOne({ zelfName: "alice.zelf" }).lean();

        expect(result.idempotent).toBe(false);
        expect(result.zelfName).toBe("alice.zelf");
        expect(result.tokenCost).toBe(10);
        expect(result.balance).toBe(90);
        expect(result.slot.expiresAt).toBe("2027-01-15T00:00:00.000Z");
        expect(account.tagName).toBe("alice");
        expect(account.spent).toBe(10);
        expect(account.slots).toHaveLength(1);
        expect(account.purchases[0].idempotencyKey).toBe("idem-alice-1");
    });

    test("the same idempotency key does not debit twice", async () => {
        const first = await buy();
        const second = await buy();
        const account = await SlotAccount.findOne({ zelfName: "alice.zelf" }).lean();

        expect(second.idempotent).toBe(true);
        expect(second.slot.slotId).toBe(first.slot.slotId);
        expect(second.balance).toBe(90);
        expect(account.spent).toBe(10);
        expect(account.slots).toHaveLength(1);
    });

    test("two concurrent purchases with one idempotency key debit once", async () => {
        const [left, right] = await Promise.all([buy(), buy()]);
        const account = await SlotAccount.findOne({ zelfName: "alice.zelf" }).lean();
        const slotIds = [left.slot.slotId, right.slot.slotId];

        expect(new Set(slotIds).size).toBe(1);
        expect(account.spent).toBe(10);
        expect([left, right].filter((row) => row.idempotent)).toHaveLength(1);
    });

    test("insufficient tokens leaves the ledger unchanged", async () => {
        const { error, handled } = await detailsOf(() => buy({ options: { balance: 9 } }));
        const account = await SlotAccount.findOne({ zelfName: "alice.zelf" }).lean();

        expect(handled.status).toBe(409);
        expect(handled.code).toBe("ERR_INSUFFICIENT_TOKENS");
        expect(error.details).toMatchObject({ balance: 9, cost: 10, kind: "password" });
        expect(account).toBeNull();
    });

    test("a second purchase cannot drive the recorded spend past the on-chain balance", async () => {
        await buy({ options: { balance: 15 } });
        const { error, handled } = await detailsOf(() =>
            buy({ body: { idempotencyKey: "idem-alice-2" }, options: { balance: 15 } }),
        );

        const account = await SlotAccount.findOne({ zelfName: "alice.zelf" }).lean();
        expect(handled.code).toBe("ERR_INSUFFICIENT_TOKENS");
        expect(error.details.balance).toBe(5);
        expect(error.details.cost).toBe(10);
        expect(account.spent).toBe(10);
    });

    test("at 0.10 USD the password slot costs 5 tokens", async () => {
        config.token.priceUsd = 0.1;
        const bob = { tagName: "bob", identifier: "other-device", domain: "zelf" };
        const result = await PlanLimits.purchaseExtraSlot(
            { kind: "password", idempotencyKey: "idem-bob-price" },
            bob,
            { plan: "free", balance: 5, domainConfig: null, now: "2026-01-15T00:00:00.000Z" },
        );
        const account = await SlotAccount.findOne({ zelfName: "bob.zelf" }).lean();

        expect(result.tokenCost).toBe(5);
        expect(result.balance).toBe(0);
        expect(account.spent).toBe(5);

        const { handled } = await detailsOf(() =>
            PlanLimits.purchaseExtraSlot({ kind: "zotp", idempotencyKey: "idem-bob-zotp" }, bob, {
                plan: "free",
                balance: 5,
                domainConfig: null,
            }),
        );
        expect(handled.code).toBe("ERR_INSUFFICIENT_TOKENS");
    });

    test("reusing a key for a different kind conflicts and does not debit", async () => {
        await buy();
        const { handled } = await detailsOf(() => buy({ body: { kind: "zotp" } }));
        const account = await SlotAccount.findOne({ zelfName: "alice.zelf" }).lean();

        expect(handled.status).toBe(409);
        expect(handled.code).toBe("ERR_IDEMPOTENCY_CONFLICT");
        expect(account.spent).toBe(10);
        expect(account.slots).toHaveLength(1);
    });

    test("a missing Zelf name is rejected and a device identifier is not an owner", async () => {
        const { handled } = await detailsOf(() =>
            PlanLimits.purchaseExtraSlot({ kind: "password", idempotencyKey: "idem-device-1" }, { identifier: "device-fingerprint-abc", domain: "zelf" }, purchaseOptions),
        );
        expect(handled.status).toBe(401);
        expect(handled.code).toBe("ERR_ZELF_IDENTITY_REQUIRED");
        expect(await SlotAccount.countDocuments()).toBe(0);
    });

    test("an expired slot stays on the account and a renewal adds a new one", async () => {
        await SlotAccount.create({
            zelfName: "alice.zelf",
            domain: "zelf",
            tagName: "alice",
            spent: 0,
            slots: [
                {
                    slotId: "expired-slot",
                    kind: "password",
                    purchasedAt: new Date("2024-01-15T00:00:00.000Z"),
                    expiresAt: new Date("2025-01-15T00:00:00.000Z"),
                    tokenCost: 10,
                    idempotencyKey: "idem-old",
                },
            ],
            purchases: [],
        });

        const before = PlanLimits.evaluateLimit({
            plan: "free",
            kind: "password",
            used: 5,
            slots: (await SlotAccount.findOne({ zelfName: "alice.zelf" }).lean()).slots,
            now: "2026-02-01T00:00:00.000Z",
        });
        expect(before.allowed).toBe(false);

        const renewed = await buy({ options: { balance: 10, now: "2026-02-01T00:00:00.000Z" } });
        const account = await SlotAccount.findOne({ zelfName: "alice.zelf" }).lean();
        const after = PlanLimits.evaluateLimit({
            plan: "free",
            kind: "password",
            used: 5,
            slots: account.slots,
            now: "2026-02-01T00:00:00.000Z",
        });

        expect(account.slots.map((slot) => slot.slotId).sort()).toEqual(["expired-slot", renewed.slot.slotId].sort());
        expect(after.allowed).toBe(true);
        expect(after.limit).toBe(6);
        expect(after.extraSlots).toBe(1);
    });

    test("unlimited plans are not sold an extra slot", async () => {
        const { handled } = await detailsOf(() => buy({ options: { plan: "unlimited" } }));
        expect(handled.code).toBe("ERR_EXTRA_SLOT_NOT_NEEDED");
        expect(await SlotAccount.countDocuments()).toBe(0);
    });

    test("usage reports plan, counts, active slots, balance, and token cost", async () => {
        await buy();
        const usage = await PlanLimits.getPlanUsage(alice, { password: 5, zotp: 1 }, { plan: "free", balance: 100, domainConfig: null, now: "2026-06-01T00:00:00.000Z" });

        expect(usage.plan).toBe("free");
        expect(usage.zelfName).toBe("alice.zelf");
        expect(usage.tokenBalance).toBe(90);
        expect(usage.onChainBalance).toBe(100);
        expect(usage.tokensSpent).toBe(10);
        expect(usage.tokenPriceUsd).toBe(0.05);
        expect(usage.kinds.password).toMatchObject({
            used: 5,
            planLimit: 5,
            limit: 6,
            extraSlots: 1,
            tokenCost: 10,
            slotUsd: 0.5,
            canAdd: true,
        });
        expect(usage.kinds.password.activeExtraSlots[0].expiresAt).toBe("2027-01-15T00:00:00.000Z");
        expect(usage.kinds.zotp).toMatchObject({ used: 1, limit: 3, extraSlots: 0, tokenCost: 20, canAdd: true });
        expect(usage.balanceAvailable).toBe(true);
    });

    test("three parallel purchases with balance for one slot produce one success and no empty accounts", async () => {
        const buyers = ["idem-race-a", "idem-race-b", "idem-race-c"].map((idempotencyKey) =>
            PlanLimits.purchaseExtraSlot({ kind: "password", idempotencyKey }, alice, {
                plan: "free",
                balance: 10,
                domainConfig: null,
                now: "2026-01-15T00:00:00.000Z",
            }),
        );
        const settled = await Promise.allSettled(buyers);
        const fulfilled = settled.filter((row) => row.status === "fulfilled");
        const rejected = settled.filter((row) => row.status === "rejected");
        const account = await SlotAccount.findOne({ zelfName: "alice.zelf" }).lean();

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(2);
        rejected.forEach((row) => expect(row.reason.clientCode).toBe("ERR_INSUFFICIENT_TOKENS"));
        expect(account.spent).toBe(10);
        expect(account.slots).toHaveLength(1);
        expect(await SlotAccount.countDocuments()).toBe(1);
    });

    test("a balance lookup failure still returns counts, limits, and costs", async () => {
        ZnsBalance.getZNSBalance.mockResolvedValue({ balance: 0, error: "rpc down" });
        const usage = await PlanLimits.getPlanUsage(
            alice,
            { password: 5, zotp: 3 },
            {
                plan: "free",
                domainConfig: null,
                tagPublicData: { solanaAddress: "So11111111111111111111111111111111111111112", plan: "free", type: "mainnet", zelfName: "alice.zelf" },
                skipTagLookup: true,
            },
        );

        expect(usage.balanceAvailable).toBe(false);
        expect(usage.tokenBalance).toBeNull();
        expect(usage.onChainBalance).toBeNull();
        expect(usage.kinds.password).toMatchObject({ used: 5, limit: 5, tokenCost: 10, canAdd: false });
        expect(usage.kinds.zotp).toMatchObject({ used: 3, limit: 3, tokenCost: 20, canAdd: false });

        const { handled } = await detailsOf(() =>
            PlanLimits.purchaseExtraSlot({ kind: "password", idempotencyKey: "idem-balance-down" }, alice, {
                plan: "free",
                domainConfig: null,
                tagPublicData: { solanaAddress: "So11111111111111111111111111111111111111112", plan: "free", type: "mainnet", zelfName: "alice.zelf" },
                skipTagLookup: true,
            }),
        );
        expect(handled.status).toBe(503);
        expect(handled.code).toBe("ERR_TOKEN_BALANCE_UNAVAILABLE");
        expect(await SlotAccount.countDocuments({ zelfName: "alice.zelf" })).toBe(0);
    });

    test("limits and slot purchase reject an identifier-only session", async () => {
        const device = { identifier: "device-fingerprint-abc", domain: "zelf" };
        const { handled } = await detailsOf(() => PlanLimits.getPlanUsage(device, { password: 1, zotp: 0 }, { plan: "free", balance: 10, domainConfig: null }));
        expect(handled.status).toBe(401);
        expect(handled.code).toBe("ERR_ZELF_IDENTITY_REQUIRED");
    });
});

describe("GET /api/zelf-keys/limits session ownership", () => {
    const run = async (user) => {
        const ctx = { state: { user }, status: undefined, body: undefined };
        let continued = false;
        await Middleware.limitsValidation(ctx, async () => {
            continued = true;
        });
        return { ctx, continued };
    };

    const createSession = (overrides) =>
        Session.create({
            identifier: `limits-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            clientIP: "127.0.0.1",
            domain: "zelf",
            isWebExtension: false,
            status: "active",
            type: "general",
            tagName: "alice",
            ...overrides,
        });

    test("no session is 401", async () => {
        const { ctx, continued } = await run(undefined);
        expect(continued).toBe(false);
        expect(ctx.status).toBe(401);
        expect(ctx.body.code).toBe("ERR_SESSION_REQUIRED");
    });

    test("a forged createWallet or decryptWallet session without a face is rejected", async () => {
        for (const type of ["createWallet", "decryptWallet"]) {
            const session = await createSession({ tagName: "alice", type, verifiedTagName: null });
            const { ctx, continued } = await run({ session: session._id, tagName: "alice", domain: "zelf" });
            expect(continued).toBe(false);
            expect(ctx.status).toBe(403);
            expect(ctx.body.code).toBe("ERR_SESSION_NOT_VERIFIED");
        }
    });

    test("a session for wallet A cannot read wallet B", async () => {
        const session = await createSession({ tagName: "alice", type: "general" });
        await SessionModule.markSessionIdentityVerified({ session: session._id, domain: "zelf" }, "alice", "zelf");
        const { ctx, continued } = await run({ session: session._id, tagName: "bob", domain: "zelf" });
        expect(continued).toBe(false);
        expect(ctx.status).toBe(403);
        expect(ctx.body.code).toBe("ERR_SESSION_OWNER_MISMATCH");
    });

    test("a tagName-only general session is not verified", async () => {
        const session = await createSession({ tagName: "alice", type: "general" });
        const { ctx, continued } = await run({ session: session._id, tagName: "alice", domain: "zelf" });
        expect(continued).toBe(false);
        expect(ctx.status).toBe(403);
        expect(ctx.body.code).toBe("ERR_SESSION_NOT_VERIFIED");
    });

    test("a successful face decrypt marks the session and /limits allows that wallet", async () => {
        const session = await createSession({ tagName: "Alice", type: "general" });
        const stamped = await SessionModule.markSessionIdentityVerified({ session: session._id, domain: "zelf" }, "Alice", "zelf");
        const stored = await Session.findById(session._id).lean();

        expect(stamped.zelfName).toBe("alice.zelf");
        expect(stored.verifiedTagName).toBe("alice.zelf");
        expect(stored.verifiedAt).toBeTruthy();
        expect(new Date(stored.verifiedUntil).getTime()).toBeGreaterThan(Date.now());

        const { ctx, continued } = await run({ session: session._id, tagName: "Alice", domain: "zelf" });
        expect(continued).toBe(true);
        expect(ctx.state.user.tagName).toBe("alice");
    });

    test("mixed-case names share one normalized vault", () => {
        expect(normalizeZelfName("JimBot", "zelf")).toEqual({ tagName: "jimbot", domain: "zelf", zelfName: "jimbot.zelf" });
        expect(normalizeZelfName("Jimbot.Zelf", "zelf").zelfName).toBe("jimbot.zelf");
        expect(normalizeZelfName("Jimbot.Zelf.zelf", "zelf").zelfName).toBe("jimbot.zelf");
    });
});

describe("POST /slots validation codes", () => {
    const run = async (body) => {
        const ctx = {
            request: { body },
            state: { user: { tagName: "alice", domain: "zelf" } },
        };
        await Middleware.purchaseSlotValidation(ctx, async () => {
            ctx.status = 200;
        });
        return ctx;
    };

    test("a bad kind returns ERR_SLOT_KIND_INVALID", async () => {
        const ctx = await run({ kind: "note", idempotencyKey: "idem-valid-1", faceBase64: "face" });
        expect(ctx.status).toBe(409);
        expect(ctx.body.code).toBe("ERR_SLOT_KIND_INVALID");
    });

    test("a short idempotency key returns ERR_IDEMPOTENCY_KEY_INVALID", async () => {
        const ctx = await run({ kind: "password", idempotencyKey: "short", faceBase64: "face" });
        expect(ctx.status).toBe(409);
        expect(ctx.body.code).toBe("ERR_IDEMPOTENCY_KEY_INVALID");
    });
});
