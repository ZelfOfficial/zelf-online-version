const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

jest.mock("../../Repositories/Tags/modules/tags.module", () => ({
    decryptTag: jest.fn(),
}));

jest.mock("../../Repositories/Tags/modules/tags-parts.module", () => ({
    decryptParams: jest.fn(async () => ({ face: "face", password: undefined })),
    decryptPasswordParams: jest.fn(async () => ({})),
    decryptCreditCardParams: jest.fn(),
    decryptNotesParams: jest.fn(),
    getFullTagName: jest.fn((tagName, domain) => {
        const resolvedDomain = domain || "zelf";
        if (tagName && tagName.includes(`.${resolvedDomain}`)) return tagName;
        return `${tagName}.${resolvedDomain}`;
    }),
    urlToBase64: jest.fn(),
}));

jest.mock("../../Core/ipfs", () => ({
    deleteFiles: jest.fn(async () => ({ success: true })),
    filter: jest.fn(async () => []),
    pinFile: jest.fn(),
    getFileById: jest.fn(),
}));

const config = require("../../Core/config");
const secret = config.JWT_SECRET || "test-jwt-secret-key-for-testing-only";
if (!config.JWT_SECRET) config.JWT_SECRET = secret;

const IPFS = require("../../Core/ipfs");
const TagsModule = require("../../Repositories/Tags/modules/tags.module");
const SessionModule = require("../../Repositories/Session/modules/session.module");
const PlanLimits = require("../../Repositories/ZelfKeys/modules/zelf-key-plan-limits.module");
const ZelfKeyModule = require("../../Repositories/ZelfKeys/modules/zelf-key.module");
const ZelfKeyMiddleware = require("../../Repositories/ZelfKeys/middlewares/zelf-key.middleware");

describe("Zelf Keys owner comes from the session, never from the identifier", () => {
    let memory;

    beforeAll(async () => {
        memory = await MongoMemoryServer.create();
        if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
        await mongoose.connect(memory.getUri());
    });

    afterAll(async () => {
        await mongoose.disconnect();
        if (memory) await memory.stop();
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    // A real token from SessionModule.insert, read the way server.js does (JWT payload, then hydrateOwner).
    const sessionUser = async (extra = {}) => {
        const created = await SessionModule.insert({
            clientIP: "203.0.113.9",
            identifier: `78d4b02964694235b35495be51f02323${Math.random().toString(36).slice(2)}`,
            domain: "zelf",
            ...extra,
        });
        const payload = jwt.verify(created.token, config.JWT_SECRET);
        return SessionModule.hydrateSessionOwner(payload);
    };

    test("a session claim is not an owner until the face check stamps it", async () => {
        const user = await sessionUser({ tagName: "alice.zelf" });

        expect(user.tagName).toBeUndefined();
        expect(user.verifiedTagName).toBeUndefined();
        expect(user.claimedTagName).toBe("alice.zelf");
        expect(() => PlanLimits.requireZelfIdentity(user)).toThrow(/ERR_ZELF_IDENTITY_REQUIRED/);
    });

    test("without tagName the throwaway identifier is never used: store and delete fail before pinning", async () => {
        const user = await sessionUser();

        await expect(
            ZelfKeyModule.storeData({ type: "zotp", faceBase64: "face", issuer: "Vercel", username: "a@a.com" }, user),
        ).rejects.toThrow(/ERR_ZELF_IDENTITY_REQUIRED/);
        await expect(ZelfKeyModule.deleteZelfKey({ id: "x", faceBase64: "face" }, user)).rejects.toThrow(/ERR_ZELF_IDENTITY_REQUIRED/);
        await expect(ZelfKeyModule.listData({ category: "zotp" }, user)).rejects.toMatchObject({ status: 401 });

        expect(TagsModule.decryptTag).not.toHaveBeenCalled();
        expect(IPFS.pinFile).not.toHaveBeenCalled();
    });

    test("a save with a claimed name face-verifies that name, and a failed check pins nothing", async () => {
        const user = await sessionUser({ tagName: "johansecurity.zelf" });
        TagsModule.decryptTag.mockRejectedValue(new Error("404:tag_not_found"));

        await expect(
            ZelfKeyModule.storeData({ type: "zotp", faceBase64: "face", issuer: "Vercel", username: "a@a.com" }, user),
        ).rejects.toBeDefined();

        expect(TagsModule.decryptTag).toHaveBeenCalledWith(
            expect.objectContaining({ tagName: "johansecurity", domain: "zelf" }),
            user,
        );
        expect(IPFS.pinFile).not.toHaveBeenCalled();
    });

    test("a verified session resolves owner for slots, swaps and limits without a tagName in the JWT", async () => {
        const created = await SessionModule.insert({ clientIP: "203.0.113.10", identifier: "device-uuid", domain: "zelf" });
        const payload = jwt.verify(created.token, config.JWT_SECRET);
        expect(payload.tagName).toBeNull();

        await SessionModule.stampVerifiedFromRecord({ session: payload.session, domain: "zelf" }, { publicData: { zelfName: "johansecurity.zelf" } });

        const user = await SessionModule.hydrateSessionOwner(payload);
        expect(user.verifiedTagName).toBe("johansecurity.zelf");
        expect(user.tagName).toBe("johansecurity");

        expect(PlanLimits.requireZelfIdentity(user).zelfName).toBe("johansecurity.zelf");

        const ctx = { state: { user }, request: { body: {} } };
        const next = jest.fn();
        await ZelfKeyMiddleware.purchaseSlotValidation(ctx, next);
        expect(ctx.status).not.toBe(401);
    });

    test("slots without any identity answer 401", async () => {
        const user = await sessionUser();
        const ctx = { state: { user }, request: { body: {} } };
        const next = jest.fn();

        await ZelfKeyMiddleware.purchaseSlotValidation(ctx, next);

        expect(ctx.status).toBe(401);
        expect(ctx.body.code).toBe("ERR_ZELF_IDENTITY_REQUIRED");
        expect(next).not.toHaveBeenCalled();
    });

    test("an expired verification falls back to the claim, which is not an owner", async () => {
        const created = await SessionModule.insert({ clientIP: "203.0.113.11", identifier: "device-2", domain: "zelf", tagName: "alice.zelf" });
        const payload = jwt.verify(created.token, config.JWT_SECRET);
        const Session = require("../../Repositories/Session/models/session.model");
        await Session.updateOne(
            { _id: payload.session },
            { $set: { verifiedTagName: "alice.zelf", verifiedAt: new Date(Date.now() - 1e6), verifiedUntil: new Date(Date.now() - 1000) } },
        );

        const user = await SessionModule.hydrateSessionOwner(payload);
        expect(user.verifiedTagName).toBeUndefined();
        expect(user.tagName).toBeUndefined();
    });
});

