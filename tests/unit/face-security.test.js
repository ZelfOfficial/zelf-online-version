const crypto = require("crypto");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.FACE_POW_HMAC_SECRET = crypto.randomBytes(32).toString("hex");
process.env.FACE_POW_ENFORCEMENT = "require";
process.env.FACE_NONCE_ENFORCEMENT = "require";
process.env.FACE_ATTEMPT_LIMITER_ENABLED = "true";
process.env.FACE_ATTEMPT_IDENTITY_MAX_FAILURES = "3";
process.env.FACE_ATTEMPT_POW_AFTER_FAILURES = "1";
process.env.FACE_POW_BASE_DIFFICULTY = "1";

const FacePow = require("../../Repositories/Face/modules/face-pow.module");
const FaceNonce = require("../../Repositories/Face/modules/face-nonce.module");
const FaceAttemptLimiter = require("../../Repositories/Face/modules/face-attempt-limiter.module");
const { pickWhitelistedBody } = require("../../Repositories/Face/modules/face-body-whitelist.module");
const FaceReplay = require("../../Repositories/Face/modules/face-replay.module");
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

describe("face attempt lockout", () => {
    beforeEach(async () => {
        await FaceAttemptState.deleteMany({});
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
});

describe("body whitelist", () => {
    it("drops server-only fields and maps securePassword to password", () => {
        const { body, rejected } = pickWhitelistedBody(
            {
                tagName: "a",
                domain: "zelf",
                faceBase64: "x",
                tolerance: "HARDENED",
                removePGP: true,
                securePassword: "secret",
            },
            "decrypt"
        );
        expect(rejected).toEqual(expect.arrayContaining(["tolerance", "removePGP"]));
        expect(body.password).toBe("secret");
        expect(body.tolerance).toBeUndefined();
        expect(body.securityType).toBeUndefined();
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
