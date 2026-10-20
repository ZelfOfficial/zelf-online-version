const crypto = require("crypto");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.FACE_POW_HMAC_SECRET = crypto.randomBytes(32).toString("hex");
process.env.FACE_ATTEMPT_LIMITER_ENABLED = "true";
process.env.FACE_ATTEMPT_IDENTITY_MAX_FAILURES = "3";
process.env.FACE_ATTEMPT_POW_AFTER_FAILURES = "1";
process.env.FACE_POW_ENFORCEMENT = "require";
process.env.FACE_NONCE_ENFORCEMENT = "require";
process.env.FACE_POW_BASE_DIFFICULTY = "1";
process.env.FACE_BODY_WHITELIST_ENABLED = "true";
process.env.FACE_REPLAY_DETECTION_ENABLED = "false";

const FacePow = require("../../Repositories/Face/modules/face-pow.module");
const FaceNonce = require("../../Repositories/Face/modules/face-nonce.module");
const FaceAttemptLimiter = require("../../Repositories/Face/modules/face-attempt-limiter.module");
const { pickWhitelistedBody } = require("../../Repositories/Face/modules/face-body-whitelist.module");
const FaceSecurity = require("../../Repositories/Face/modules/face-security.module");
const FaceMiddleware = require("../../Repositories/Face/middlewares/face.middleware");

const solvePow = (salt, difficulty) => {
    for (let n = 0; n < 500000; n++) {
        const hash = crypto.createHash("sha256").update(`${salt}${n}`).digest("hex");
        if (FacePow.hashMeetsDifficulty(hash, difficulty)) return n;
    }
    throw new Error("pow not solved");
};

const makeCtx = (bodyOverrides = {}) => {
    const headers = {};
    return {
        request: {
            body: {
                tagName: "alice.zelf",
                domain: "zelf",
                faceBase64: "Zm9v",
                os: "DESKTOP",
                password: "enc",
                tolerance: "HARDENED",
                removePGP: true,
                ...bodyOverrides,
            },
            ip: "203.0.113.10",
        },
        state: {
            user: { session: "sess-a", identifier: "ext-user" },
            extractedDomain: "zelf",
        },
        status: undefined,
        body: undefined,
        path: "/api/tags/decrypt",
        set(name, value) {
            headers[name.toLowerCase()] = value;
        },
        get(name) {
            return headers[name.toLowerCase()];
        },
    };
};

const runDecryptGate = async (ctx, downstream) => {
    const mw = FaceMiddleware.gate("decrypt");
    await mw(ctx, async () => {
        if (downstream) await downstream(ctx);
        else {
            ctx.status = 200;
            ctx.body = { data: { ok: true } };
        }
    });
};

let memoryServer;

beforeAll(async () => {
    memoryServer = await MongoMemoryServer.create();
    await mongoose.connect(memoryServer.getUri());
});

afterAll(async () => {
    await mongoose.disconnect();
    if (memoryServer) await memoryServer.stop();
});

beforeEach(async () => {
    const collections = await mongoose.connection.db.collections();
    for (const col of collections) {
        await col.deleteMany({});
    }
});

describe("tags decrypt face gate (integration-style)", () => {
    it("strips server-only fields from the body before the controller runs", async () => {
        const { body, rejected } = pickWhitelistedBody(
            {
                tagName: "a",
                domain: "zelf",
                faceBase64: "x",
                os: "DESKTOP",
                tolerance: "HARDENED",
                removePGP: true,
            },
            "decrypt"
        );
        expect(rejected).toEqual([]);
        expect(body.tolerance).toBeUndefined();
        expect(body.removePGP).toBeUndefined();
        expect(body.faceBase64).toBe("x");
    });

    it("returns 428 pow_required then succeeds after a valid solution", async () => {
        await FaceAttemptLimiter.recordFailedAttempt({
            identityKey: "decrypt:alice.zelf@zelf",
            ip: "203.0.113.10",
            deviceKey: "sess-a",
        });

        const ctx1 = makeCtx();
        await runDecryptGate(ctx1);
        expect(ctx1.status).toBe(428);
        expect(ctx1.body.code).toBe("pow_required");
        expect(ctx1.body.pow).toBeDefined();

        const { nonce } = await FaceNonce.createNonce({
            action: "decrypt",
            identifier: "alice.zelf@zelf",
            sessionKey: "sess-a",
        });

        const solution = solvePow(ctx1.body.pow.salt, ctx1.body.pow.difficulty);
        const ctx2 = makeCtx({
            faceNonce: nonce,
            pow: { challengeId: ctx1.body.pow.challengeId, solution },
        });
        await runDecryptGate(ctx2);
        expect(ctx2.status).toBe(200);
    });

    it("rejects reused face nonce when enforcement is require", async () => {
        const { nonce } = await FaceNonce.createNonce({
            action: "decrypt",
            identifier: "alice.zelf@zelf",
            sessionKey: "sess-a",
        });

        const challenge = await FacePow.issueChallenge({
            action: "decrypt",
            identifier: "alice.zelf@zelf",
            failureCount: 2,
        });
        const solution = solvePow(challenge.salt, challenge.difficulty);

        const ctxOk = makeCtx({
            faceNonce: nonce,
            pow: { challengeId: challenge.challengeId, solution },
        });
        await runDecryptGate(ctxOk);
        expect(ctxOk.status).toBe(200);

        const challenge2 = await FacePow.issueChallenge({
            action: "decrypt",
            identifier: "alice.zelf@zelf",
            failureCount: 2,
        });
        const solution2 = solvePow(challenge2.salt, challenge2.difficulty);
        const ctxReplay = makeCtx({
            faceNonce: nonce,
            pow: { challengeId: challenge2.challengeId, solution: solution2 },
        });
        await runDecryptGate(ctxReplay);
        expect(ctxReplay.status).toBe(409);
        expect(ctxReplay.body.code).toBe("face_nonce_used");
    });

    it("locks out after repeated failures and resets after success", async () => {
        const identityKey = "decrypt:alice.zelf@zelf";
        for (let i = 0; i < 3; i++) {
            await FaceAttemptLimiter.recordFailedAttempt({
                identityKey,
                ip: "203.0.113.10",
                deviceKey: "sess-a",
            });
        }

        const ctxLocked = makeCtx();
        await runDecryptGate(ctxLocked);
        expect(ctxLocked.status).toBe(429);
        expect(ctxLocked.body.code).toBe("face_locked");

        await FaceAttemptLimiter.recordSuccessfulAttempt({
            identityKey,
            deviceKey: "sess-a",
        });

        const { nonce } = await FaceNonce.createNonce({
            action: "decrypt",
            identifier: "alice.zelf@zelf",
            sessionKey: "sess-a",
        });
        const challenge = await FacePow.issueChallenge({
            action: "decrypt",
            identifier: "alice.zelf@zelf",
            failureCount: 2,
        });
        const solution = solvePow(challenge.salt, challenge.difficulty);
        const ctxAfterReset = makeCtx({
            faceNonce: nonce,
            pow: { challengeId: challenge.challengeId, solution },
        });
        await runDecryptGate(ctxAfterReset);
        expect(ctxAfterReset.status).toBe(200);
    });

    it("does not lock out from IP-only failures when IP lockout is disabled", async () => {
        const identityKey = "decrypt:other@zelf";
        for (let i = 0; i < 50; i++) {
            await FaceAttemptLimiter.recordFailedAttempt({
                identityKey: `decrypt:tag${i}@zelf`,
                ip: "198.51.100.1",
                deviceKey: "sess-shared",
            });
        }

        const { nonce } = await FaceNonce.createNonce({
            action: "decrypt",
            identifier: "fresh@zelf",
            sessionKey: "sess-new",
        });
        const challenge = await FacePow.issueChallenge({
            action: "decrypt",
            identifier: "fresh@zelf",
            failureCount: 0,
        });
        const solution = solvePow(challenge.salt, challenge.difficulty);

        const ctx = makeCtx({
            tagName: "fresh.zelf",
            faceNonce: nonce,
            pow: { challengeId: challenge.challengeId, solution },
        });
        ctx.state.user = { session: "sess-new" };
        await runDecryptGate(ctx);
        expect(ctx.status).not.toBe(429);
    });
});
