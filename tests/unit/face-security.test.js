const crypto = require("crypto");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.FACE_POW_HMAC_SECRET = crypto.randomBytes(32).toString("hex");
process.env.FACE_POW_ENFORCEMENT = "require";
process.env.FACE_NONCE_ENFORCEMENT = "require";
process.env.FACE_ATTEMPT_LIMITER_ENABLED = "true";
process.env.FACE_ATTEMPT_IDENTITY_MAX_FAILURES = "3";
process.env.FACE_ATTEMPT_POW_AFTER_FAILURES = "1";
process.env.FACE_POW_BASE_DIFFICULTY = "8";
process.env.FACE_ATTEMPT_LOCKOUT_STEPS_SEC = "900,3600,86400";
process.env.FACE_ATTEMPT_IDENTITY_WINDOW_SEC = "900";

const config = require("../../Core/config");
const FacePow = require("../../Repositories/Face/modules/face-pow.module");
const FaceNonce = require("../../Repositories/Face/modules/face-nonce.module");
const FaceAttemptLimiter = require("../../Repositories/Face/modules/face-attempt-limiter.module");
const { pickWhitelistedBody } = require("../../Repositories/Face/modules/face-body-whitelist.module");
const FaceReplay = require("../../Repositories/Face/modules/face-replay.module");
const FaceSecurity = require("../../Repositories/Face/modules/face-security.module");
const FaceMiddleware = require("../../Repositories/Face/middlewares/face.middleware");
const FacePowChallenge = require("../../Repositories/Face/models/face-pow-challenge.model");
const FacePowUsed = require("../../Repositories/Face/models/face-pow-used.model");
const FaceNonceModel = require("../../Repositories/Face/models/face-nonce.model");
const FaceAttemptState = require("../../Repositories/Face/models/face-attempt-state.model");
const FaceReplayDigest = require("../../Repositories/Face/models/face-replay-digest.model");

let memoryServer;

beforeAll(async () => {
    memoryServer = await MongoMemoryServer.create();
    await mongoose.connect(memoryServer.getUri());
});

afterAll(async () => {
    await mongoose.disconnect();
    if (memoryServer) await memoryServer.stop();
});

const solvePow = (salt, difficulty) => {
    for (let n = 0; n < 500000; n++) {
        const hash = crypto.createHash("sha256").update(`${salt}${n}`).digest("hex");
        if (FacePow.hashMeetsDifficulty(hash, difficulty)) return n;
    }
    throw new Error("could not solve pow in test loop");
};

describe("face proof-of-work", () => {
    beforeEach(async () => {
        await Promise.all([
            FacePowChallenge.deleteMany({}),
            FacePowUsed.deleteMany({}),
        ]);
    });

    it("issues a signed challenge and verifies solution once", async () => {
        const challenge = await FacePow.issueChallenge({
            action: "decrypt",
            identifier: "alice@zelf",
            failureCount: 1,
        });

        const solution = solvePow(challenge.salt, challenge.difficulty);
        const ok = await FacePow.verifySolution({
            challengeId: challenge.challengeId,
            solution,
            identifier: "alice@zelf",
            action: "decrypt",
        });
        expect(ok.ok).toBe(true);

        const replay = await FacePow.verifySolution({
            challengeId: challenge.challengeId,
            solution,
            identifier: "alice@zelf",
            action: "decrypt",
        });
        expect(replay.ok).toBe(false);
    });

    it("returns a clear 503 when FACE_POW_HMAC_SECRET is missing after failed face attempts", async () => {
        const original = config.faceSecurity.pow.hmacSecret;
        config.faceSecurity.pow.hmacSecret = "";
        try {
            await FaceAttemptLimiter.recordFailedAttempt({
                identityKey: "purchase-slot:alice@zelf",
                deviceKey: "sess-pow-missing",
                ip: "127.0.0.1",
            });

            const ctx = {
                request: {
                    body: { faceBase64: "ZmFjZQ==", kind: "password", idempotencyKey: "idem-key-01" },
                    ip: "127.0.0.1",
                },
                state: { user: { tagName: "alice", domain: "zelf", session: "sess-pow-missing" } },
                path: "/api/zelf-keys/slots",
                status: undefined,
                body: undefined,
                set() {},
                get() {},
            };

            await FaceMiddleware.gate("purchase-slot")(ctx, async () => {
                ctx.status = 200;
            });

            expect(ctx.status).toBe(503);
            expect(ctx.body.code).toBe("face_pow_unconfigured");
            expect(ctx.body.message).toMatch(/FACE_POW_HMAC_SECRET/);
        } finally {
            config.faceSecurity.pow.hmacSecret = original;
        }
    });

    it("rejects expired or wrong-identity challenges", async () => {
        const challenge = await FacePow.issueChallenge({
            action: "decrypt",
            identifier: "alice@zelf",
            failureCount: 2,
        });
        const solution = solvePow(challenge.salt, challenge.difficulty);

        const wrongIdentity = await FacePow.verifySolution({
            challengeId: challenge.challengeId,
            solution,
            identifier: "bob@zelf",
            action: "decrypt",
        });
        expect(wrongIdentity.ok).toBe(false);
    });
});

describe("face nonce", () => {
    beforeEach(async () => {
        await FaceNonceModel.deleteMany({});
    });

    it("consumes a nonce only once and binds action/identifier/session", async () => {
        const { nonce } = await FaceNonce.createNonce({
            action: "decrypt",
            identifier: "alice@zelf",
            sessionKey: "sess-1",
        });

        const first = await FaceNonce.consumeNonce({
            nonce,
            action: "decrypt",
            identifier: "alice@zelf",
            sessionKey: "sess-1",
        });
        expect(first.ok).toBe(true);

        const second = await FaceNonce.consumeNonce({
            nonce,
            action: "decrypt",
            identifier: "alice@zelf",
            sessionKey: "sess-1",
        });
        expect(second.code).toBe("face_nonce_used");

        const mismatch = await FaceNonce.consumeNonce({
            nonce: crypto.randomBytes(12).toString("hex"),
            action: "lease",
            identifier: "alice@zelf",
            sessionKey: "sess-1",
        });
        expect(mismatch.ok).toBe(false);
    });
});

describe("face attempt lockout TTL", () => {
    it("retains state through lock duration plus level decay", () => {
        const now = new Date("2026-06-01T12:00:00Z");
        const lockedUntil = new Date(now.getTime() + 86400 * 1000);
        const expires = FaceAttemptLimiter.computeStateExpiresAt(
            { windowStartedAt: now, lockedUntil },
            now
        );
        expect(expires.getTime()).toBeGreaterThanOrEqual(lockedUntil.getTime() + 86400 * 1000);
        expect(expires.getTime()).toBeGreaterThan(now.getTime() + 3600 * 1000);
    });
});

describe("face attempt lockout", () => {
    beforeEach(async () => {
        await FaceAttemptState.deleteMany({});
        jest.useRealTimers();
    });

    it("locks identity after max failures", async () => {
        const identityKey = "decrypt:alice@zelf";
        for (let i = 0; i < 3; i++) {
            await FaceAttemptLimiter.recordFailedAttempt({
                identityKey,
                ip: "203.0.113.1",
                deviceKey: "dev-1",
            });
        }

        await expect(
            FaceAttemptLimiter.assertFaceAttemptAllowed({
                identityKey,
                ip: "203.0.113.99",
                deviceKey: "dev-2",
            })
        ).rejects.toMatchObject({ clientCode: "face_locked", status: 429 });
    });

    it("uses first lockout step (900s) on initial lock", async () => {
        const identityKey = "decrypt:alice@zelf";
        for (let i = 0; i < 3; i++) {
            await FaceAttemptLimiter.recordFailedAttempt({
                identityKey,
                deviceKey: "dev-1",
            });
        }

        try {
            await FaceAttemptLimiter.assertFaceAttemptAllowed({ identityKey, deviceKey: "dev-1" });
            throw new Error("expected lock");
        } catch (err) {
            expect(err.retryAfterSeconds).toBeLessThanOrEqual(900);
            expect(err.retryAfterSeconds).toBeGreaterThan(850);
        }
    });

    it("keeps lock active after failure window rolls but before lock expires", async () => {
        const identityKey = "decrypt:alice@zelf";
        const now = Date.now();
        await FaceAttemptState.create({
            scope: "identity",
            key: identityKey,
            failureCount: 0,
            windowStartedAt: new Date(now - 16 * 60 * 1000),
            lockedUntil: new Date(now + 30 * 60 * 1000),
            lockoutLevel: 1,
            expiresAt: new Date(now + 3600000),
        });

        await expect(
            FaceAttemptLimiter.assertFaceAttemptAllowed({ identityKey, deviceKey: "dev-1" })
        ).rejects.toMatchObject({ clientCode: "face_locked" });

        const row = await FaceAttemptState.findOne({ scope: "identity", key: identityKey }).lean();
        expect(row.lockedUntil).toBeTruthy();
        expect(new Date(row.lockedUntil).getTime()).toBeGreaterThan(Date.now());
    });

    it("isolates zelf-keys lockout per JWT tag when body has no tag", async () => {
        const keyF = FaceSecurity.buildLockoutIdentityKey(
            "store-password",
            { faceBase64: "x" },
            { state: { user: { session: "sess-f", tagName: "f", domain: "zelf" } } }
        );
        const keyP = FaceSecurity.buildLockoutIdentityKey(
            "store-password",
            { faceBase64: "x" },
            { state: { user: { session: "sess-p", tagName: "p", domain: "zelf" } } }
        );
        expect(keyF).toBe("store-password:f@zelf");
        expect(keyP).toBe("store-password:p@zelf");

        for (let i = 0; i < 3; i++) {
            await FaceAttemptLimiter.recordFailedAttempt({
                identityKey: keyF,
                deviceKey: "sess-f",
            });
        }

        await expect(
            FaceAttemptLimiter.assertFaceAttemptAllowed({ identityKey: keyF, deviceKey: "sess-f" })
        ).rejects.toMatchObject({ clientCode: "face_locked" });

        await expect(
            FaceAttemptLimiter.assertFaceAttemptAllowed({ identityKey: keyP, deviceKey: "sess-p" })
        ).resolves.toBeDefined();
    });
});

describe("face pow difficulty", () => {
    it("escalates +1 bit per two failures after powAfter (not before)", () => {
        const config = require("../../Core/config");
        const base = config.faceSecurity.pow.baseDifficulty;
        const powAfter = config.faceSecurity.attemptLimiter.powAfterFailures;
        const ladder = (fc) =>
            Math.min(
                config.faceSecurity.pow.maxDifficulty,
                base + Math.max(0, Math.floor((fc - powAfter) / 2))
            );
        expect(FacePow.difficultyForFailures(powAfter)).toBe(ladder(powAfter));
        expect(FacePow.difficultyForFailures(powAfter + 1)).toBe(ladder(powAfter + 1));
        expect(FacePow.difficultyForFailures(powAfter + 2)).toBe(ladder(powAfter + 2));
        expect(FacePow.difficultyForFailures(powAfter + 4)).toBe(ladder(powAfter + 4));
    });

    it("uses leading zero bits", () => {
        expect(FacePow.leadingZeroBits("0000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")).toBe(16);
        expect(
            FacePow.hashMeetsDifficulty(
                "0000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                16
            )
        ).toBe(true);
        expect(
            FacePow.hashMeetsDifficulty(
                "0001ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                16
            )
        ).toBe(false);
    });
});

describe("body whitelist", () => {
    it("drops server-only fields and maps securePassword to password", () => {
        const { body, strippedServerOnly } = pickWhitelistedBody(
            {
                tagName: "a",
                domain: "zelf",
                faceBase64: "x",
                os: "DESKTOP",
                addServerPassword: true,
                tolerance: "HARDENED",
                removePGP: true,
                securePassword: "secret",
            },
            "decrypt"
        );
        expect(strippedServerOnly).toEqual(expect.arrayContaining(["tolerance", "removePGP"]));
        expect(body.os).toBe("DESKTOP");
        expect(body.password).toBe("secret");
        expect(body.addServerPassword).toBe(true);
        expect(body.tolerance).toBeUndefined();
        expect(body.removePGP).toBeUndefined();
        expect(body.securityType).toBeUndefined();
    });
});

describe("face replay middleware", () => {
    beforeEach(async () => {
        await FaceReplayDigest.deleteMany({});
        await FaceNonceModel.deleteMany({});
    });

    it("returns JSON face_replay_detected from gate middleware", async () => {
        await FaceReplay.recordReplay({
            faceBase64: "aGVsbG8=",
            identifier: "alice@zelf",
            action: "decrypt",
        });

        const { nonce } = await FaceNonce.createNonce({
            action: "decrypt",
            identifier: "alice@zelf",
            sessionKey: "s1",
        });

        const ctx = {
            request: {
                body: {
                    tagName: "alice",
                    domain: "zelf",
                    faceBase64: "aGVsbG8=",
                    faceNonce: nonce,
                    os: "DESKTOP",
                },
                ip: "127.0.0.1",
            },
            state: { user: { session: "s1", tagName: "alice", domain: "zelf" } },
            path: "/api/tags/decrypt",
            set() {},
            get() {},
        };

        const mw = FaceMiddleware.gate("decrypt");
        await mw(ctx, async () => {
            ctx.status = 200;
        });

        expect(ctx.status).toBe(409);
        expect(ctx.body.code).toBe("face_replay_detected");
        expect(ctx.body.clientMessage).toMatch(/fresh nonce/i);
    });
});

describe("face replay digest", () => {
    beforeEach(async () => {
        await FaceReplayDigest.deleteMany({});
    });

    it("rejects identical face payloads after a successful record", async () => {
        await FaceReplay.recordReplay({
            faceBase64: "aGVsbG8=",
            identifier: "alice@zelf",
            action: "decrypt",
        });

        await expect(
            FaceReplay.checkNotReplay({
                faceBase64: "aGVsbG8=",
                identifier: "alice@zelf",
                action: "decrypt",
            })
        ).rejects.toMatchObject({ clientCode: "face_replay_detected" });
    });
});
