jest.mock("../../Repositories/Tags/modules/tags.module", () => ({
    decryptTag: jest.fn(),
}));

jest.mock("../../Repositories/Tags/modules/tags-parts.module", () => ({
    decryptParams: jest.fn(),
    decryptPasswordParams: jest.fn(),
    decryptCreditCardParams: jest.fn(),
    decryptNotesParams: jest.fn(),
    getFullTagName: jest.fn(),
    urlToBase64: jest.fn(),
}));

jest.mock("../../Core/ipfs", () => ({
    deleteFiles: jest.fn(async () => ({ success: true })),
    filter: jest.fn(async () => []),
    pinFile: jest.fn(),
}));

jest.mock("../../Repositories/ZelfProof/modules/zelf-proof.module", () => ({
    encrypt: jest.fn(),
    decrypt: jest.fn(),
    preview: jest.fn(),
    previewWithLegacyFallback: jest.fn(),
    passwordLayerRequiresPassword: jest.fn(),
    ZELFPROOF_CLIENT_ERROR_STATUS: {
        ERR_INVALID_PASSWORD: 401,
        ERR_PASSWORD_REQUIRED: 409,
    },
}));

const TagsModule = require("../../Repositories/Tags/modules/tags.module");
const IPFS = require("../../Core/ipfs");

const {
    resolveZelfIdPasswordForOwnership,
    remapZelfKeyCaughtError,
    deleteZelfKey,
} = require("../../Repositories/ZelfKeys/modules/zelf-key.module");

const authToken = { tagName: "leaseuser", identifier: "leaseuser", domain: "zelf" };

describe("Zelf Keys ownership + error codes", () => {
    it("does not use site password for password-type store ownership", () => {
        expect(
            resolveZelfIdPasswordForOwnership({
                type: "password",
                password: "site-secret",
                masterPassword: "key-layer",
            }),
        ).toBeUndefined();
    });

    it("uses password for non-password store ownership", () => {
        expect(
            resolveZelfIdPasswordForOwnership({
                type: "notes",
                password: "zelf-id-password",
            }),
        ).toBe("zelf-id-password");
    });

    it("maps invalid password to 401 ERR_INVALID_PASSWORD", () => {
        expect(() => remapZelfKeyCaughtError(new Error("invalid password provided"))).toThrow("401:ERR_INVALID_PASSWORD");
    });

    it("maps missing password to 409 ERR_PASSWORD_REQUIRED", () => {
        expect(() => remapZelfKeyCaughtError(new Error("password is required"))).toThrow("409:ERR_PASSWORD_REQUIRED");
    });

    it("maps liveness failures to 422 without matching generic face text", () => {
        expect(() => remapZelfKeyCaughtError(new Error("face is not central"))).toThrow("422:ERR_LIVENESS_FAILED");
        expect(() => remapZelfKeyCaughtError(new Error("face metadata mismatch"))).toThrow("face metadata mismatch");
    });
});

describe("deleteZelfKey ownership (_validateOwnership / decryptTag)", () => {
    beforeEach(() => {
        TagsModule.decryptTag.mockReset();
        IPFS.deleteFiles.mockClear();
    });

    it("allows face-only Zelf IDs without a password", async () => {
        TagsModule.decryptTag.mockResolvedValue({});

        const result = await deleteZelfKey({ id: "pin-1", faceBase64: "face-data" }, authToken);

        expect(TagsModule.decryptTag).toHaveBeenCalledWith(
            expect.objectContaining({
                faceBase64: "face-data",
                password: undefined,
                tagName: "leaseuser",
                domain: "zelf",
            }),
            authToken,
        );
        expect(IPFS.deleteFiles).toHaveBeenCalledWith(["pin-1"]);
        expect(result.success).toBe(true);
    });

    it("passes optional Zelf ID password for face+password IDs", async () => {
        TagsModule.decryptTag.mockResolvedValue({});

        await deleteZelfKey({ id: "pin-2", faceBase64: "face-data", password: "zelf-id-secret" }, authToken);

        expect(TagsModule.decryptTag).toHaveBeenCalledWith(
            expect.objectContaining({ password: "zelf-id-secret" }),
            authToken,
        );
    });

    it("rejects delete when decryptTag reports a face mismatch", async () => {
        TagsModule.decryptTag.mockRejectedValue(new Error("face not recognized"));

        await expect(deleteZelfKey({ id: "pin-3", faceBase64: "bad-face" }, authToken)).rejects.toThrow(
            "422:ERR_LIVENESS_FAILED",
        );
        expect(IPFS.deleteFiles).not.toHaveBeenCalled();
    });
});
