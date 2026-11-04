const crypto = require("crypto");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.FACE_POW_HMAC_SECRET = crypto.randomBytes(32).toString("hex");
process.env.FACE_NONCE_ENFORCEMENT = "require";
process.env.FACE_POW_ENFORCEMENT = "log";
process.env.FACE_ATTEMPT_LIMITER_ENABLED = "false";
process.env.FACE_REPLAY_DETECTION_ENABLED = "false";

const FaceSecurity = require("../../Repositories/Face/modules/face-security.module");
const FaceNonce = require("../../Repositories/Face/modules/face-nonce.module");
const FaceMiddleware = require("../../Repositories/Face/middlewares/face.middleware");
const FaceController = require("../../Repositories/Face/controllers/face.controller");

const JWT_USER = {
    session: "sess-f-123",
    tagName: "f",
    domain: "zelf",
    identifier: "device-hash-f",
};

const makeIssueCtx = (action, clientIdentifier = "session:anonymous") => ({
    request: {
        body: { action, identifier: clientIdentifier },
        ip: "203.0.113.1",
    },
    state: { user: JWT_USER },
    status: undefined,
    body: undefined,
    set() {},
    get() {},
});

const makeGateCtx = (action, bodyExtra = {}) => ({
    request: {
        body: {
            faceBase64: "Zm9vYmFy",
            os: "DESKTOP",
            zelfProof: "proof-from-client-should-not-bind",
            ...bodyExtra,
        },
        ip: "203.0.113.1",
    },
    state: { user: JWT_USER, extractedDomain: "zelf" },
    status: undefined,
    body: undefined,
    path: `/api/zelf-keys/${action}`,
    set() {},
    get() {},
});

const issueNonceViaController = async (action, clientIdentifier) => {
    const ctx = makeIssueCtx(action, clientIdentifier);
    await FaceController.issueNonce(ctx);
    expect(ctx.status).toBeUndefined();
    expect(ctx.body?.data?.bindingIdentifier).toBe("f@zelf");
    return ctx.body.data;
};

const runGate = async (action, nonce, bodyExtra = {}) => {
    const ctx = makeGateCtx(action, { faceNonce: nonce, ...bodyExtra });
    const mw = FaceMiddleware.gate(action);
    await mw(ctx, async () => {
        ctx.status = 200;
        ctx.body = { data: { ok: true } };
    });
    return ctx;
};

const ZELF_KEY_ACTIONS = [
    "store-password",
    "store-passwords-bulk",
    "store-zotp",
    "store-notes",
    "store-credit-card",
    "retrieve",
    "preview",
    "delete",
    "change-master-password",
];

let memoryServer;

beforeAll(async () => {
    memoryServer = await MongoMemoryServer.create();
    await mongoose.connect(memoryServer.getUri());
});

afterAll(async () => {
    await mongoose.disconnect();
    if (memoryServer) await memoryServer.stop();
});

describe("face nonce binding (JWT-first)", () => {
    it.each(ZELF_KEY_ACTIONS)("zelf-keys %s: wrong client identifier still round-trips", async (action) => {
        const issued = await issueNonceViaController(action, "session:anonymous");
        const ctx = await runGate(action, issued.nonce);
        expect(ctx.status).toBe(200);
    });

    it("tags decrypt round-trip with tag in body but JWT binding wins", async () => {
        const issued = await issueNonceViaController("decrypt", "zelfProof:deadbeef");
        const ctx = makeGateCtx("decrypt", {
            faceNonce: issued.nonce,
            tagName: "f",
            domain: "zelf",
        });
        ctx.path = "/api/tags/decrypt";
        const mw = FaceMiddleware.gate("decrypt");
        await mw(ctx, async () => {
            ctx.status = 200;
        });
        expect(ctx.status).toBe(200);
    });

    it("wallet-decrypt round-trip", async () => {
        const issued = await issueNonceViaController("wallet-decrypt", "session:anonymous");
        const ctx = makeGateCtx("wallet-decrypt", { faceNonce: issued.nonce });
        const mw = FaceMiddleware.gate("wallet-decrypt");
        await mw(ctx, async () => {
            ctx.status = 200;
        });
        expect(ctx.status).toBe(200);
    });

    it("mismatch when nonce was minted with a different binding (legacy bug)", async () => {
        const { nonce } = await FaceNonce.createNonce({
            action: "store-password",
            identifier: "session:anonymous",
            sessionKey: JWT_USER.session,
        });
        const ctx = await runGate("store-password", nonce);
        expect(ctx.status).toBe(409);
        expect(ctx.body.code).toBe("face_nonce_mismatch");
    });

    it("resolveFaceNonceContext ignores client identifier", () => {
        const ctx = makeIssueCtx("store-password", "zelfProof:wrong");
        const resolved = FaceSecurity.resolveFaceNonceContext(ctx);
        expect(resolved.bindingIdentifier).toBe("f@zelf");
        expect(resolved.identityKey).toBe("store-password:f@zelf");
    });
});
