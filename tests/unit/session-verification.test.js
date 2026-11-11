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
const { decrypt } = require("../../Repositories/Wallet/modules/encryption");
const StoredZelfProof = require("../../Repositories/Wallet/modules/stored-zelf-proof.module");
const SessionModule = require("../../Repositories/Session/modules/session.module");
const Session = require("../../Repositories/Session/models/session.model");
const WalletModule = require("../../Repositories/Wallet/modules/wallet.module");
const { requireVerifiedWallet } = require("../../Repositories/ZelfKeys/middlewares/zelf-key.middleware");
const { myPlanValidation } = require("../../Repositories/ZelfID/middlewares/zelf-ids-my-plan.middleware");

const secret = config.JWT_SECRET || "test-jwt-secret-key-for-testing-only";
if (!config.JWT_SECRET) config.JWT_SECRET = secret;

describe("session verification comes from the decrypted record", () => {
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
        decrypt.mockReset();
        decrypt.mockResolvedValue({
            publicData: { zelfName: "alice.zelf" },
            metadata: { mnemonic: "test mnemonic" },
        });
        StoredZelfProof.findStoredZelfProof.mockReset();
        StoredZelfProof.findStoredZelfProof.mockResolvedValue(null);
    });

    const openSession = async (extra = {}) => {
        const created = await SessionModule.insert({
            clientIP: "203.0.113.8",
            identifier: `device-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            domain: "zelf",
            tagName: "bob.zelf",
            verifiedTagName: "bob.zelf",
            zelfName: "bob.zelf",
            ...extra,
        });
        const claims = jwt.verify(created.token, config.JWT_SECRET);
        const stored = await Session.findById(claims.session);
        return { created, claims, stored };
    };

    test("POST /api/sessions ignores a client tagName and does not verify the session", async () => {
        const { claims, stored } = await openSession();
        expect(stored.tagName).toBeFalsy();
        expect(stored.verifiedTagName).toBeFalsy();
        expect(stored.verifiedAt).toBeFalsy();
        expect(stored.verifiedUntil).toBeFalsy();
        expect(claims.tagName).toBeUndefined();
        expect(claims.verifiedTagName).toBeUndefined();
        expect(claims.typ).toBe("session");
    });

    test("decrypting wallet A while passing zelfName B does not verify the session for B", async () => {
        const { stored } = await openSession();
        await expect(
            WalletModule.decryptWallet(
                {
                    zelfProof: "proof-a",
                    faceBase64: "face",
                    password: "secret",
                    zelfName: "bob.zelf",
                    skipQRCode: true,
                    removePGP: true,
                    domain: "zelf",
                },
                { session: stored._id, domain: "zelf" }
            )
        ).rejects.toMatchObject({ status: 403, code: "ZELF_NAME_MISMATCH" });

        const after = await Session.findById(stored._id).lean();
        expect(after.verifiedTagName).toBeFalsy();
        expect(after.tagName).toBeFalsy();
    });

    test("a decrypt that is not the stored record does not verify the session", async () => {
        const { stored } = await openSession();
        StoredZelfProof.findStoredZelfProof.mockResolvedValue(null);

        const result = await WalletModule.decryptWallet(
            {
                zelfProof: "local-proof",
                faceBase64: "face",
                password: "secret",
                zelfName: "alice",
                skipQRCode: true,
                removePGP: true,
                domain: "zelf",
            },
            { session: stored._id, domain: "zelf" }
        );

        expect(result.publicData.zelfName).toBe("alice.zelf");
        const after = await Session.findById(stored._id).lean();
        expect(after.verifiedTagName).toBeFalsy();
    });

    test("a client blob labelled as another name does not verify the session", async () => {
        const { stored } = await openSession();
        decrypt.mockResolvedValue({
            publicData: { zelfName: "victim.zelf" },
            metadata: { mnemonic: "other mnemonic" },
        });
        StoredZelfProof.findStoredZelfProof.mockResolvedValue({
            zelfName: "victim.zelf",
            zelfProof: "stored-proof",
        });

        await expect(
            WalletModule.decryptWallet(
                {
                    zelfProof: "labelled-proof",
                    faceBase64: "face",
                    password: "secret",
                    zelfName: "victim",
                    skipQRCode: true,
                    removePGP: true,
                    domain: "zelf",
                },
                { session: stored._id, domain: "zelf" }
            )
        ).rejects.toMatchObject({ status: 403, code: "ZELF_PROOF_MISMATCH" });

        const after = await Session.findById(stored._id).lean();
        expect(after.verifiedTagName).toBeFalsy();
    });

    test("a matching decrypt stamps the record name, and unverified tagName is not enough", async () => {
        const { stored } = await openSession();
        StoredZelfProof.findStoredZelfProof.mockResolvedValue({
            zelfName: "alice.zelf",
            zelfProof: "proof-a",
        });
        await Session.updateOne({ _id: stored._id }, { $set: { tagName: "bob.zelf" } });

        const ctx = {
            state: { user: { session: stored._id, tagName: "bob.zelf", domain: "zelf" } },
            status: 200,
        };
        const allowed = await requireVerifiedWallet(ctx, { requestedIdentifier: "bob.zelf" });
        expect(allowed).toBe(false);
        expect(ctx.status).toBe(403);
        expect(ctx.body.code).toBe("ERR_SESSION_NOT_VERIFIED");

        const planCtx = {
            state: { user: { session: stored._id, tagName: "bob.zelf", domain: "zelf" } },
            request: { query: { zelfName: "bob.zelf" } },
            status: 200,
        };
        const next = jest.fn();
        await myPlanValidation(planCtx, next);
        expect(next).not.toHaveBeenCalled();
        expect(planCtx.status).toBe(403);
        expect(planCtx.body.code).toBe("ERR_SESSION_NOT_VERIFIED");

        await WalletModule.decryptWallet(
            {
                zelfProof: "proof-a",
                faceBase64: "face",
                password: "secret",
                zelfName: "alice",
                skipQRCode: true,
                removePGP: true,
                domain: "zelf",
            },
            { session: stored._id, domain: "zelf" }
        );

        const stamped = await Session.findById(stored._id).lean();
        expect(stamped.verifiedTagName).toBe("alice.zelf");
        expect(stamped.tagName).toBe("bob.zelf");

        const owner = {
            state: { user: { session: stored._id, domain: "zelf" } },
            status: 200,
        };
        expect(await requireVerifiedWallet(owner, { requestedIdentifier: "alice.zelf" })).toBe(true);
        expect(await requireVerifiedWallet({ state: { user: { session: stored._id, domain: "zelf" } }, status: 200 }, { requestedIdentifier: "bob.zelf" })).toBe(
            false
        );
    });
});
