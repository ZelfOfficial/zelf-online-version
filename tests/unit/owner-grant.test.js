const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

jest.mock("../../Repositories/Wallet/modules/encryption", () => ({
    decrypt: jest.fn(),
    encrypt: jest.fn(),
    preview: jest.fn(),
    encryptQR: jest.fn(),
}));

jest.mock("../../Repositories/Wallet/modules/stored-zelf-proof.module", () => ({
    findStoredZelfProof: jest.fn(async () => null),
    proofsMatch: (left, right) => {
        if (typeof left !== "string" || typeof right !== "string") return false;
        const a = Buffer.from(left.trim());
        const b = Buffer.from(right.trim());
        return a.length > 0 && a.length === b.length && a.equals(b);
    },
}));

const config = require("../../Core/config");
const { acceptAccessToken, BLOCKED_PRIVILEGE_TYPES, signToken, TOKEN_TYPES } = require("../../Core/jwt-claims");
const { decrypt } = require("../../Repositories/Wallet/modules/encryption");
const StoredZelfProof = require("../../Repositories/Wallet/modules/stored-zelf-proof.module");
const WalletModule = require("../../Repositories/Wallet/modules/wallet.module");
const SessionModule = require("../../Repositories/Session/modules/session.module");
const Session = require("../../Repositories/Session/models/session.model");
const SessionController = require("../../Repositories/Session/controllers/session.controller");
const { hydrateOwner } = require("../../Repositories/Session/middlewares/session.middleware");
const OwnerGrant = require("../../Repositories/Session/modules/owner-grant.module");
const PlanLimits = require("../../Repositories/ZelfKeys/modules/zelf-key-plan-limits.module");
const SwapUsage = require("../../Repositories/ZelfID/models/zelf-id-swap-usage.model");
const ChainMiddleware = require("../../Repositories/ZelfID/middlewares/zelf-id-chains.middleware");
const KeyMiddleware = require("../../Repositories/ZelfKeys/middlewares/zelf-key.middleware");

const GRANT_SECRET = "owner-grant-test-secret";
const SESSION_SECRET = config.JWT_SECRET || "test-jwt-secret-key-for-testing-only";
if (!config.JWT_SECRET) config.JWT_SECRET = SESSION_SECRET;

const WINDOW_MS = 10 * 60 * 1000;

describe("owner grant", () => {
    let memory;
    let previousGrantSecret;
    let previousTtl;

    beforeAll(async () => {
        previousGrantSecret = process.env.OWNER_GRANT_SECRET;
        previousTtl = process.env.OWNER_GRANT_TTL;
        process.env.OWNER_GRANT_SECRET = GRANT_SECRET;
        delete process.env.OWNER_GRANT_TTL;

        memory = await MongoMemoryServer.create();
        if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
        await mongoose.connect(memory.getUri());
        await SwapUsage.init();
    });

    afterAll(async () => {
        if (previousGrantSecret === undefined) delete process.env.OWNER_GRANT_SECRET;
        else process.env.OWNER_GRANT_SECRET = previousGrantSecret;
        if (previousTtl === undefined) delete process.env.OWNER_GRANT_TTL;
        else process.env.OWNER_GRANT_TTL = previousTtl;

        await mongoose.disconnect();
        if (memory) await memory.stop();
    });

    beforeEach(async () => {
        process.env.OWNER_GRANT_SECRET = GRANT_SECRET;
        delete process.env.OWNER_GRANT_TTL;
        decrypt.mockReset();
        decrypt.mockResolvedValue({
            publicData: { zelfName: "alice.zelf", ownerGrant: "forged-from-record" },
            metadata: { mnemonic: "test mnemonic" },
            ownerGrant: "forged-from-record",
        });
        StoredZelfProof.findStoredZelfProof.mockReset();
        StoredZelfProof.findStoredZelfProof.mockResolvedValue(null);
        await SwapUsage.deleteMany({});
    });

    const openSession = async (extra = {}) => {
        const identifier = extra.identifier || `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const created = await SessionModule.insert({
            clientIP: "203.0.113.8",
            identifier,
            domain: "zelf",
            tagName: "mallory",
            ...extra,
            identifier,
        });
        const claims = jwt.verify(created.token, config.JWT_SECRET);
        const stored = await Session.findById(claims.session);
        return { created, claims, stored, identifier };
    };

    const faceCheck = async (stored) => {
        StoredZelfProof.findStoredZelfProof.mockResolvedValue({
            zelfName: "alice.zelf",
            zelfProof: "proof-a",
        });
        return WalletModule.decryptWallet(
            {
                zelfProof: "proof-a",
                faceBase64: "face",
                password: "secret",
                zelfName: "alice",
                skipQRCode: true,
                removePGP: true,
                domain: "zelf",
            },
            { session: stored._id, identifier: "not-the-stored-device", domain: "zelf" }
        );
    };

    const hydrate = async (token) => {
        const ctx = { state: { user: jwt.verify(token, config.JWT_SECRET) }, status: 200 };
        let continued = false;
        await hydrateOwner(ctx, async () => {
            continued = true;
        });
        expect(continued).toBe(true);
        return ctx.state.user;
    };

    const runMiddleware = async (validation, user, body) => {
        const ctx = {
            state: { user },
            request: { body: body || {}, query: {} },
            status: 200,
            body: undefined,
        };
        let continued = false;
        await validation(ctx, async () => {
            continued = true;
        });
        return { ctx, continued };
    };

    test("a face check returns a grant bound to the stored identifier and the verified owner", async () => {
        const { stored, identifier } = await openSession();
        const result = await faceCheck(stored);

        expect(result.ownerGrant).toEqual(expect.any(String));
        expect(result.ownerGrant).not.toBe("forged-from-record");
        expect(result.publicData.ownerGrant).toBeUndefined();

        const claims = jwt.verify(result.ownerGrant, GRANT_SECRET);
        expect(claims.typ).toBe("owner_grant");
        expect(claims.sub).toBe("alice.zelf");
        expect(claims.dom).toBe("zelf");
        expect(claims.sid_ident).toBe(identifier);
        expect(claims.sid_ident).not.toBe("not-the-stored-device");
        expect(result.ownerGrantExpiresAt).toBe(claims.exp);
        expect(claims.exp - claims.iat).toBe(12 * 60 * 60);

        const stamped = await Session.findById(stored._id).lean();
        expect(stamped.verifiedTagName).toBe("alice.zelf");
        expect(new Date(stamped.verifiedUntil).getTime() - new Date(stamped.verifiedAt).getTime()).toBe(WINDOW_MS);
        expect(stamped.tagName).toBe("mallory");
    });

    test("a new session is stamped from the grant, not from the client tagName", async () => {
        const { stored, identifier } = await openSession();
        const face = await faceCheck(stored);

        const created = await SessionModule.insert({
            clientIP: "203.0.113.9",
            identifier,
            domain: "zelf",
            tagName: "mallory.zelf",
            verifiedTagName: "victim.zelf",
            zelfName: "victim.zelf",
            ownerGrant: face.ownerGrant,
        });

        expect(created.verifiedTagName).toBe("alice.zelf");
        expect(Object.keys(created).sort()).toEqual(["activatedAt", "expiresAt", "token", "verifiedTagName", "verifiedUntil"]);

        const claims = jwt.verify(created.token, config.JWT_SECRET);
        expect(claims.typ).toBe("session");
        expect(claims.tagName).toBe("mallory.zelf");
        expect(claims.verifiedTagName).toBeUndefined();
        expect(claims.ownerGrant).toBeUndefined();

        const row = await Session.findById(claims.session).lean();
        expect(row.verifiedTagName).toBe("alice.zelf");
        expect(row.tagName).toBe("mallory.zelf");
        expect(new Date(row.verifiedUntil).getTime() - new Date(row.verifiedAt).getTime()).toBe(WINDOW_MS);

        const user = await hydrate(created.token);
        expect(user.verifiedTagName).toBe("alice.zelf");
        expect(user.tagName).toBe("alice");
        expect(user.claimedTagName).toBe("mallory.zelf");

        const limits = await runMiddleware(KeyMiddleware.limitsValidation, user);
        expect(limits.continued).toBe(true);

        const activate = await runMiddleware(ChainMiddleware.activateValidation, user, { chain: "solana" });
        expect(activate.continued).toBe(true);
        expect(activate.ctx.state.user.tagName).toBe("alice");

        const unstamped = await SessionModule.insert({
            clientIP: "203.0.113.9",
            identifier,
            domain: "zelf",
            tagName: "alice.zelf",
        });
        expect(Object.keys(unstamped).sort()).toEqual(["activatedAt", "expiresAt", "token"]);
        const unstampedUser = await hydrate(unstamped.token);
        const blockedLimits = await runMiddleware(KeyMiddleware.limitsValidation, unstampedUser);
        expect(blockedLimits.continued).toBe(false);
        expect(blockedLimits.ctx.body.code).toBe("ERR_SESSION_NOT_VERIFIED");
        const blockedActivate = await runMiddleware(ChainMiddleware.activateValidation, unstampedUser, { chain: "solana" });
        expect(blockedActivate.continued).toBe(false);
        expect(blockedActivate.ctx.body.code).toBe("ERR_SESSION_NOT_VERIFIED");
    });

    test("a swap on a grant-stamped session is counted for the grant owner", async () => {
        const { stored, identifier } = await openSession();
        const face = await faceCheck(stored);
        const created = await SessionModule.insert({
            clientIP: "203.0.113.9",
            identifier,
            domain: "zelf",
            tagName: "mallory",
            ownerGrant: face.ownerGrant,
        });
        const user = await hydrate(created.token);
        const entitlement = {
            plan: "free",
            domainConfig: { zelfkeys: { planLimits: { free: { swapsPerMonth: 1 } } } },
            skipTagLookup: true,
            skipSubscriptionLookup: true,
            tagPublicData: { plan: "free", type: "mainnet", zelfName: "alice.zelf", tagName: "alice" },
            now: "2026-11-03T12:00:00.000Z",
        };
        const execute = jest.fn().mockResolvedValue({ tx: "counted" });

        const done = await PlanLimits.executeLimitedSwap({ authUser: user, execute, ...entitlement });

        expect(done.result).toEqual({ tx: "counted" });
        expect(done.swaps).toEqual({ count: 1, limit: 1, periodKey: "2026-11", plan: "free" });
        expect(await PlanLimits.readSwapCount("alice.zelf", "2026-11")).toBe(1);
        expect(await PlanLimits.readSwapCount("mallory.zelf", "2026-11")).toBe(0);
        expect(execute).toHaveBeenCalledTimes(1);

        await expect(PlanLimits.executeLimitedSwap({ authUser: user, execute: jest.fn(), ...entitlement })).rejects.toMatchObject({
            clientCode: "ERR_PLAN_LIMIT_REACHED",
        });
        expect(await PlanLimits.readSwapCount("alice.zelf", "2026-11")).toBe(1);

        const plain = await SessionModule.insert({
            clientIP: "203.0.113.10",
            identifier: `other-${identifier}`,
            domain: "zelf",
            tagName: "alice",
        });
        const plainUser = await hydrate(plain.token);
        const skipped = jest.fn();
        await expect(PlanLimits.executeLimitedSwap({ authUser: plainUser, execute: skipped, ...entitlement })).rejects.toMatchObject({
            clientCode: "ERR_ZELF_IDENTITY_REQUIRED",
        });
        expect(skipped).not.toHaveBeenCalled();
        expect(await SwapUsage.countDocuments()).toBe(1);
    });

    test("an expired grant is rejected and does not create a session", async () => {
        const identifier = `expired-${Date.now()}`;
        const issued = OwnerGrant.issueOwnerGrant({
            zelfName: "alice",
            domain: "zelf",
            identifier,
            exp: Math.floor(Date.now() / 1000) - 30,
        });

        await expect(
            SessionModule.insert({
                clientIP: "203.0.113.12",
                identifier,
                domain: "zelf",
                tagName: "alice",
                ownerGrant: issued.ownerGrant,
            })
        ).rejects.toMatchObject({ status: 401, code: "ERR_OWNER_GRANT_EXPIRED" });

        expect(await Session.countDocuments({ identifier })).toBe(0);
    });

    test("a tampered grant, a foreign identifier, and a foreign signature are rejected", async () => {
        const { stored, identifier } = await openSession();
        const face = await faceCheck(stored);
        const before = await Session.countDocuments({ identifier });

        const parts = face.ownerGrant.split(".");
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
        payload.sub = "mallory.zelf";
        parts[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
        const tampered = parts.join(".");

        await expect(
            SessionModule.insert({
                clientIP: "203.0.113.13",
                identifier,
                domain: "zelf",
                tagName: "mallory",
                ownerGrant: tampered,
            })
        ).rejects.toMatchObject({ code: "ERR_OWNER_GRANT_INVALID" });

        await expect(
            SessionModule.insert({
                clientIP: "203.0.113.13",
                identifier: `${identifier}-other-device`,
                domain: "zelf",
                tagName: "alice",
                ownerGrant: face.ownerGrant,
            })
        ).rejects.toMatchObject({ code: "ERR_OWNER_GRANT_INVALID" });

        await expect(
            SessionModule.insert({
                clientIP: "203.0.113.13",
                identifier,
                domain: "bdag",
                tagName: "alice",
                ownerGrant: face.ownerGrant,
            })
        ).rejects.toMatchObject({ code: "ERR_OWNER_GRANT_INVALID" });

        const foreign = signToken({ sub: "alice.zelf", dom: "zelf", sid_ident: identifier }, "some-other-secret", {
            typ: TOKEN_TYPES.ownerGrant,
            expiresIn: 60,
        });
        await expect(
            SessionModule.insert({
                clientIP: "203.0.113.13",
                identifier,
                domain: "zelf",
                ownerGrant: foreign,
            })
        ).rejects.toMatchObject({ code: "ERR_OWNER_GRANT_INVALID" });

        const sessionToken = (
            await SessionModule.insert({ clientIP: "203.0.113.14", identifier: `session-as-grant-${Date.now()}`, domain: "zelf" })
        ).token;
        await expect(
            SessionModule.insert({
                clientIP: "203.0.113.14",
                identifier,
                domain: "zelf",
                ownerGrant: sessionToken,
            })
        ).rejects.toMatchObject({ code: "ERR_OWNER_GRANT_INVALID" });

        expect(await Session.countDocuments({ identifier })).toBe(before);
    });

    test("rotating OWNER_GRANT_SECRET revokes an outstanding grant", async () => {
        const { stored, identifier } = await openSession();
        const face = await faceCheck(stored);

        process.env.OWNER_GRANT_SECRET = "rotated-owner-grant-secret";
        await expect(
            SessionModule.insert({
                clientIP: "203.0.113.15",
                identifier,
                domain: "zelf",
                ownerGrant: face.ownerGrant,
            })
        ).rejects.toMatchObject({ code: "ERR_OWNER_GRANT_INVALID" });

        const renewed = await faceCheck(stored);
        const created = await SessionModule.insert({
            clientIP: "203.0.113.15",
            identifier,
            domain: "zelf",
            tagName: "mallory",
            ownerGrant: renewed.ownerGrant,
        });
        expect(created.verifiedTagName).toBe("alice.zelf");
        expect(jwt.verify(renewed.ownerGrant, "rotated-owner-grant-secret").sub).toBe("alice.zelf");
    });

    test("without OWNER_GRANT_SECRET the grant uses the session secret and still cannot be a bearer token", async () => {
        delete process.env.OWNER_GRANT_SECRET;
        const { stored, identifier } = await openSession();
        const face = await faceCheck(stored);
        const claims = jwt.verify(face.ownerGrant, config.JWT_SECRET);
        expect(claims.typ).toBe("owner_grant");
        expect(claims.sub).toBe("alice.zelf");

        const created = await SessionModule.insert({
            clientIP: "203.0.113.16",
            identifier,
            domain: "zelf",
            tagName: "mallory",
            ownerGrant: face.ownerGrant,
        });
        expect(created.verifiedTagName).toBe("alice.zelf");

        const ctx = { state: { user: claims }, path: "/api/lifi/execute-advanced-step-transaction", status: 200 };
        const next = jest.fn();
        await acceptAccessToken(ctx, next);
        expect(next).not.toHaveBeenCalled();
        expect(ctx.status).toBe(401);
        expect(ctx.body.code).toBe("INVALID_TOKEN_TYPE");
        expect(BLOCKED_PRIVILEGE_TYPES.has("owner_grant")).toBe(true);
    });

    test("POST /api/sessions does not log the grant or the session token", async () => {
        const { stored, identifier } = await openSession();
        const face = await faceCheck(stored);
        const log = jest.spyOn(console, "log").mockImplementation(() => {});
        const err = jest.spyOn(console, "error").mockImplementation(() => {});

        try {
            const ctx = {
                request: {
                    header: { origin: "https://test.example.com" },
                    ip: "203.0.113.20",
                    body: {
                        identifier,
                        domain: "zelf",
                        tagName: "mallory",
                        ownerGrant: face.ownerGrant,
                    },
                },
                state: {},
                status: 200,
            };
            await SessionController.create(ctx);
            expect(ctx.body.data.verifiedTagName).toBe("alice.zelf");

            const parts = face.ownerGrant.split(".");
            parts[2] = `${parts[2].slice(0, -2)}aa`;
            const tampered = parts.join(".");
            const rejected = {
                request: {
                    header: { origin: "https://test.example.com" },
                    ip: "203.0.113.21",
                    body: { identifier, domain: "zelf", ownerGrant: tampered },
                },
                state: {},
                status: 200,
            };
            await SessionController.create(rejected);
            expect(rejected.status).toBe(401);
            expect(rejected.body).toEqual({
                error: "ERR_OWNER_GRANT_INVALID",
                code: "ERR_OWNER_GRANT_INVALID",
                message: "Owner grant is invalid",
            });

            const dumped = JSON.stringify(log.mock.calls) + JSON.stringify(err.mock.calls);
            expect(dumped).not.toContain(face.ownerGrant);
            expect(dumped).not.toContain(tampered);
            expect(dumped).not.toContain(ctx.body.data.token);
        } finally {
            log.mockRestore();
            err.mockRestore();
        }
    });

    test("OWNER_GRANT_TTL accepts 12h by default and a duration override", () => {
        expect(OwnerGrant.parseOwnerGrantTtl(undefined)).toBe(12 * 60 * 60);
        expect(OwnerGrant.parseOwnerGrantTtl("")).toBe(12 * 60 * 60);
        expect(OwnerGrant.parseOwnerGrantTtl("nope")).toBe(12 * 60 * 60);
        expect(OwnerGrant.parseOwnerGrantTtl("0")).toBe(12 * 60 * 60);
        expect(OwnerGrant.parseOwnerGrantTtl("43200")).toBe(43200);
        expect(OwnerGrant.parseOwnerGrantTtl("12h")).toBe(12 * 60 * 60);
        expect(OwnerGrant.parseOwnerGrantTtl("2h")).toBe(7200);
        expect(OwnerGrant.ownerGrantTtlSeconds()).toBe(12 * 60 * 60);
        process.env.OWNER_GRANT_TTL = "2h";
        expect(OwnerGrant.ownerGrantTtlSeconds()).toBe(7200);
    });
});
