jest.mock("../../Repositories/Tags/modules/tags-parts.module", () => ({
    decryptParams: jest.fn(),
    decryptPasswordParams: jest.fn(),
    getFullTagName: jest.fn((tagName, domain) => `${tagName}.${domain || "zelf"}`),
}));

jest.mock("../../Repositories/Tags/modules/tags.module", () => ({
    decryptTag: jest.fn(),
}));

jest.mock("../../Repositories/ZelfProof/modules/zelf-proof.module", () => ({
    encrypt: jest.fn(),
    decrypt: jest.fn(),
    preview: jest.fn(),
    previewWithLegacyFallback: jest.fn(),
    passwordLayerRequiresPassword: jest.fn((layer) => {
        if (layer === "WithPassword") return true;
        if (layer === "WithoutPassword") return false;
        return undefined;
    }),
    ZELFPROOF_CLIENT_ERROR_STATUS: {
        ERR_INVALID_PASSWORD: 401,
        ERR_PASSWORD_REQUIRED: 409,
        ERR_VERIFICATION_FAILED: 422,
    },
}));

jest.mock("../../Repositories/Tags/modules/qr-zelfproof-extractor.module", () => ({
    generateQRFromZelfProof: jest.fn(),
    extractZelfProofFromQR: jest.fn(),
}));

jest.mock("../../Repositories/ZelfKeys/modules/zelf-key-ipfs.module", () => ({
    saveZelfKey: jest.fn(),
}));

jest.mock("../../Core/ipfs", () => ({
    pinFile: jest.fn(),
    filter: jest.fn(),
    deleteFiles: jest.fn(),
    getFileById: jest.fn(),
}));

jest.mock("../../Repositories/ZelfID/modules/zelf-id-monthly-access.module", () => ({
    runMonthlyAccess: jest.fn(async (ctx, trigger, producer) => {
        ctx.body = { data: await producer() };
    }),
}));

jest.mock("../../Repositories/Face/modules/face-replay.module", () => ({
    checkNotReplay: jest.fn(),
    recordReplay: jest.fn(),
}));

jest.mock("../../Repositories/Face/modules/face-attempt-limiter.module", () => ({
    assertFaceAttemptAllowed: jest.fn(async () => ({ failureCount: 0, powRequired: false })),
    recordFailedAttempt: jest.fn(),
    recordSuccessfulAttempt: jest.fn(),
}));

const TagsPartsModule = require("../../Repositories/Tags/modules/tags-parts.module");
const ZelfProofModule = require("../../Repositories/ZelfProof/modules/zelf-proof.module");
const FaceReplay = require("../../Repositories/Face/modules/face-replay.module");
const FaceAttemptLimiter = require("../../Repositories/Face/modules/face-attempt-limiter.module");
const FaceMiddleware = require("../../Repositories/Face/middlewares/face.middleware");
const Middleware = require("../../Repositories/ZelfKeys/middlewares/zelf-key.middleware");
const Controller = require("../../Repositories/ZelfKeys/controllers/zelf-key.controller");
const ZelfKeyModule = require("../../Repositories/ZelfKeys/modules/zelf-key.module");

const authToken = { tagName: "alice", identifier: "alice", domain: "zelf" };

const zotpKey = (proof) => ({
    metadata: { setupKey: `SECRET-${proof}`, username: `${proof}@example.com` },
    publicData: { type: "zotp", protection: "face", issuer: proof },
});

describe("ZelfKeys bulk zOTP retrieve middleware", () => {
    const validate = async (body) => {
        const ctx = { request: { body } };
        let nextCalled = false;
        await Middleware.retrieveZOTPsValidation(ctx, async () => {
            nextCalled = true;
        });
        return { ctx, nextCalled };
    };

    it("accepts one face with several proofs", async () => {
        const { ctx, nextCalled } = await validate({
            faceBase64: "face",
            items: [{ zelfProof: "a", v: "4" }, { zelfProof: "b" }],
        });

        expect(nextCalled).toBe(true);
        expect(ctx.status).toBeUndefined();
    });

    it("rejects an empty list, a proof-less item and more than the maximum", async () => {
        for (const items of [
            [],
            [{ v: "4" }],
            Array.from({ length: Middleware.BULK_ZOTP_RETRIEVE_MAX + 1 }, (_, i) => ({ zelfProof: `p${i}` })),
        ]) {
            const { ctx, nextCalled } = await validate({ faceBase64: "face", items });
            expect(nextCalled).toBe(false);
            expect(ctx.status).toBe(409);
        }
    });

    it("requires the face", async () => {
        const { ctx, nextCalled } = await validate({ items: [{ zelfProof: "a" }] });

        expect(nextCalled).toBe(false);
        expect(ctx.status).toBe(409);
    });
});

describe("ZelfKeys bulk zOTP retrieve module", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, "error").mockImplementation(() => {});
        jest.spyOn(console, "warn").mockImplementation(() => {});

        TagsPartsModule.decryptParams.mockResolvedValue({ face: "decrypted-face", password: undefined });
        ZelfProofModule.preview.mockResolvedValue({
            publicData: { protection: "face", type: "zotp", v: "4" },
            passwordLayer: "WithoutPassword",
        });
        ZelfProofModule.previewWithLegacyFallback.mockResolvedValue({
            publicData: { protection: "face", type: "zotp" },
            passwordLayer: "WithoutPassword",
        });
        ZelfProofModule.decrypt.mockImplementation(async ({ zelfProof }) => zotpKey(zelfProof));
    });

    afterEach(() => {
        console.error.mockRestore();
        console.warn.mockRestore();
    });

    it("opens every record with the same face and keeps each index", async () => {
        const result = await ZelfKeyModule.retrieveZOTPsBulk(
            {
                faceBase64: "face",
                items: [{ zelfProof: "stripe", v: "4" }, { zelfProof: "mercury", v: "4" }, { zelfProof: "hubspot" }],
            },
            authToken
        );

        expect(result).toMatchObject({ total: 3, successCount: 3, failedCount: 0, failed: [] });
        expect(result.success.map((entry) => [entry.index, entry.metadata.setupKey])).toEqual([
            [0, "SECRET-stripe"],
            [1, "SECRET-mercury"],
            [2, "SECRET-hubspot"],
        ]);
        expect(ZelfProofModule.decrypt).toHaveBeenCalledTimes(3);
        for (const [call] of ZelfProofModule.decrypt.mock.calls) {
            expect(call.faceBase64).toBe("decrypted-face");
        }
    });

    it("reports the records that failed and returns the rest", async () => {
        ZelfProofModule.decrypt.mockImplementation(async ({ zelfProof }) => {
            if (zelfProof === "mercury") throw new Error("upstream down");
            return zotpKey(zelfProof);
        });

        const result = await ZelfKeyModule.retrieveZOTPsBulk(
            { faceBase64: "face", items: [{ zelfProof: "stripe" }, { zelfProof: "mercury" }, { zelfProof: "hubspot" }] },
            authToken
        );

        expect(result.success.map((entry) => entry.index)).toEqual([0, 2]);
        expect(result.failed).toEqual([expect.objectContaining({ index: 1, message: "upstream down" })]);
    });

    it("refuses records that are not zOTP so passwords keep their transport encryption", async () => {
        ZelfProofModule.decrypt.mockImplementation(async ({ zelfProof }) =>
            zelfProof === "note"
                ? { metadata: { text: "x" }, publicData: { type: "contact", protection: "face" } }
                : zotpKey(zelfProof)
        );

        const result = await ZelfKeyModule.retrieveZOTPsBulk(
            { faceBase64: "face", items: [{ zelfProof: "stripe" }, { zelfProof: "note" }] },
            authToken
        );

        expect(result.success.map((entry) => entry.index)).toEqual([0]);
        expect(result.failed).toEqual([expect.objectContaining({ index: 1, message: "not_a_zotp" })]);
        expect(JSON.stringify(result)).not.toContain('"text"');
    });

    it("asks for the password only on face + password records", async () => {
        ZelfProofModule.preview.mockImplementation(async ({ zelfProof }) => ({
            publicData: { protection: zelfProof === "bank" ? "face_password" : "face", type: "zotp", v: "4" },
            passwordLayer: zelfProof === "bank" ? "WithPassword" : "WithoutPassword",
        }));

        const result = await ZelfKeyModule.retrieveZOTPsBulk(
            { faceBase64: "face", items: [{ zelfProof: "stripe", v: "4" }, { zelfProof: "bank", v: "4" }] },
            authToken
        );

        expect(result.success.map((entry) => entry.index)).toEqual([0]);
        expect(result.failed).toEqual([expect.objectContaining({ index: 1, code: "ERR_MISSING_PASSWORD" })]);
    });

    it("throws the first error when nothing opens, so the face lockout counts it", async () => {
        ZelfProofModule.decrypt.mockRejectedValue(new Error("Liveness check failed"));

        await expect(
            ZelfKeyModule.retrieveZOTPsBulk(
                { faceBase64: "face", items: [{ zelfProof: "stripe" }, { zelfProof: "mercury" }] },
                authToken
            )
        ).rejects.toThrow(/ERR_VERIFICATION_FAILED/);
    });
});

describe("POST /zelf-keys/retrieve/zotps behind the face gate", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, "error").mockImplementation(() => {});
        jest.spyOn(console, "warn").mockImplementation(() => {});
        jest.spyOn(console, "info").mockImplementation(() => {});

        TagsPartsModule.decryptParams.mockResolvedValue({ face: "decrypted-face", password: undefined });
        ZelfProofModule.previewWithLegacyFallback.mockResolvedValue({
            publicData: { protection: "face", type: "zotp" },
            passwordLayer: "WithoutPassword",
        });
        ZelfProofModule.decrypt.mockImplementation(async ({ zelfProof }) => zotpKey(zelfProof));
    });

    afterEach(() => {
        console.error.mockRestore();
        console.warn.mockRestore();
        console.info.mockRestore();
    });

    const run = async (body) => {
        // Like Koa: setting the body without a status answers 200.
        let status;
        let responseBody;
        const ctx = {
            request: { body, ip: "127.0.0.1" },
            state: { user: { ...authToken, session: "s1" } },
            path: "/api/zelf-keys/retrieve/zotps",
            get: () => undefined,
            set: jest.fn(),
            get status() {
                return status;
            },
            set status(value) {
                status = value;
            },
            get body() {
                return responseBody;
            },
            set body(value) {
                responseBody = value;
                if (status === undefined) status = 200;
            },
        };
        await FaceMiddleware.gate("retrieve")(ctx, () => Controller.retrieveZOTPs(ctx));
        return ctx;
    };

    it("checks and records the capture once for the whole list", async () => {
        const ctx = await run({
            faceBase64: "face",
            items: [{ zelfProof: "stripe" }, { zelfProof: "mercury" }, { zelfProof: "hubspot" }],
        });

        expect(ctx.status).toBe(200);
        expect(ctx.body.data.successCount).toBe(3);
        expect(FaceReplay.checkNotReplay).toHaveBeenCalledTimes(1);
        expect(FaceReplay.checkNotReplay).toHaveBeenCalledWith(
            expect.objectContaining({ action: "retrieve", identifier: "alice@zelf" })
        );
        expect(FaceReplay.recordReplay).toHaveBeenCalledTimes(1);
        expect(FaceAttemptLimiter.recordSuccessfulAttempt).toHaveBeenCalledTimes(1);
    });

    it("keeps the items through the face body filter", async () => {
        const ctx = await run({ faceBase64: "face", items: [{ zelfProof: "stripe" }] });

        expect(ctx.request.body.items).toEqual([{ zelfProof: "stripe" }]);
    });

    it("counts a failed face as one failed attempt and does not record the capture", async () => {
        ZelfProofModule.decrypt.mockRejectedValue(new Error("Liveness check failed"));

        const ctx = await run({ faceBase64: "face", items: [{ zelfProof: "stripe" }, { zelfProof: "mercury" }] });

        expect(ctx.status).toBe(422);
        expect(ctx.body.code).toBe("ERR_VERIFICATION_FAILED");
        expect(FaceAttemptLimiter.recordFailedAttempt).toHaveBeenCalledTimes(1);
        expect(FaceReplay.recordReplay).not.toHaveBeenCalled();
    });

    it("rejects a capture that was already used", async () => {
        FaceReplay.checkNotReplay.mockImplementationOnce(async () => {
            const error = new Error("409:face_replay_detected");
            error.status = 409;
            error.clientCode = "face_replay_detected";
            throw error;
        });

        const ctx = await run({ faceBase64: "face", items: [{ zelfProof: "stripe" }] });

        expect(ctx.status).toBe(409);
        expect(ctx.body.code).toBe("face_replay_detected");
        expect(ZelfProofModule.decrypt).not.toHaveBeenCalled();
    });
});
