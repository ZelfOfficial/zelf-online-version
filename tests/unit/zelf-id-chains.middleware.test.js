const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const Session = require("../../Repositories/Session/models/session.model");
const Middleware = require("../../Repositories/ZelfID/middlewares/zelf-id-chains.middleware");

jest.setTimeout(120000);

let memoryServer;

beforeAll(async () => {
    memoryServer = await MongoMemoryServer.create();
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    await mongoose.connect(memoryServer.getUri());
});

afterAll(async () => {
    await mongoose.disconnect();
    if (memoryServer) await memoryServer.stop();
});

const createSession = (overrides) =>
    Session.create({
        identifier: `chains-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        clientIP: "127.0.0.1",
        domain: "zelf",
        isWebExtension: false,
        status: "active",
        type: "general",
        tagName: "alice",
        verifiedTagName: null,
        verifiedUntil: null,
        ...overrides,
    });

const run = async (validation, user, body) => {
    const ctx = {
        request: { body: body || {} },
        state: { user },
        status: undefined,
        body: undefined,
    };
    let continued = false;
    await validation(ctx, async () => {
        continued = true;
    });
    return { ctx, continued };
};

describe("POST /api/zelf-ids/chains/activate session", () => {
    test("activate uses the decrypt stamp, not the name stored at session create", async () => {
        const unverified = await createSession({ tagName: "Alice" });
        const denied = await run(Middleware.activateValidation, { session: unverified._id, tagName: "alice.zelf", domain: "zelf" }, { chain: "sol" });
        expect(denied.continued).toBe(false);
        expect(denied.ctx.status).toBe(403);
        expect(denied.ctx.body.code).toBe("ERR_SESSION_NOT_VERIFIED");

        const session = await createSession({
            tagName: "bob",
            verifiedTagName: "alice.zelf",
            verifiedUntil: new Date(Date.now() + 10 * 60 * 1000),
        });
        const { ctx, continued } = await run(Middleware.activateValidation, { session: session._id, domain: "zelf" }, { chain: "sol" });

        expect(continued).toBe(true);
        expect(ctx.state.user.tagName).toBe("alice");
        expect(ctx.state.user.domain).toBe("zelf");
        expect(ctx.request.body.chain).toBe("sol");
    });

    test("a session verified for one Zelf ID cannot activate another", async () => {
        const session = await createSession({
            verifiedTagName: "alice.zelf",
            verifiedUntil: new Date(Date.now() + 10 * 60 * 1000),
        });
        const { ctx, continued } = await run(Middleware.activateValidation, { session: session._id, tagName: "bob", domain: "zelf" }, { chain: "sol" });

        expect(continued).toBe(false);
        expect(ctx.status).toBe(403);
        expect(ctx.body.code).toBe("ERR_SESSION_OWNER_MISMATCH");
    });

    test("missing, inactive, and unnamed sessions are rejected", async () => {
        const absent = await run(Middleware.activateValidation, undefined, { chain: "sol" });
        expect(absent.ctx.status).toBe(401);
        expect(absent.ctx.body.code).toBe("ERR_SESSION_REQUIRED");

        const used = await createSession({ status: "used" });
        const inactive = await run(Middleware.activateValidation, { session: used._id, tagName: "alice", domain: "zelf" }, { chain: "sol" });
        expect(inactive.ctx.status).toBe(401);
        expect(inactive.ctx.body.code).toBe("ERR_SESSION_REQUIRED");

        const unnamed = await createSession({ tagName: null, verifiedTagName: null });
        const identity = await run(Middleware.activateValidation, { session: unnamed._id, tagName: "alice", domain: "zelf" }, { chain: "sol" });
        expect(identity.ctx.status).toBe(403);
        expect(identity.ctx.body.code).toBe("ERR_SESSION_NOT_VERIFIED");
    });

    test("chain is still required", async () => {
        const session = await createSession({
            verifiedTagName: "alice.zelf",
            verifiedUntil: new Date(Date.now() + 10 * 60 * 1000),
        });
        const { ctx, continued } = await run(Middleware.activateValidation, { session: session._id, tagName: "alice", domain: "zelf" }, {});

        expect(continued).toBe(false);
        expect(ctx.status).toBe(409);
        expect(ctx.body.validationError).toMatch(/chain/);
    });

    test("GET /chains still requires the face-verified session", async () => {
        const session = await createSession({ tagName: "alice", verifiedTagName: null });
        const { ctx, continued } = await run(Middleware.statusValidation, { session: session._id, tagName: "alice", domain: "zelf" });

        expect(continued).toBe(false);
        expect(ctx.status).toBe(403);
        expect(ctx.body.code).toBe("ERR_SESSION_NOT_VERIFIED");
    });
});
