jest.mock("../../Repositories/Tags/modules/tags.module", () => ({
    decryptTag: jest.fn(),
}));

jest.mock("../../Repositories/Tags/modules/tags-parts.module", () => ({
    decryptParams: jest.fn(),
    decryptPasswordParams: jest.fn(),
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

jest.mock("../../Repositories/ZelfProof/modules/zelf-proof.module", () => ({
    encrypt: jest.fn(),
    decrypt: jest.fn(),
    preview: jest.fn(),
    previewWithLegacyFallback: jest.fn(),
    passwordLayerRequiresPassword: jest.fn(),
    ZELFPROOF_CLIENT_ERROR_STATUS: {
        ERR_INVALID_PASSWORD: 401,
        ERR_PASSWORD_REQUIRED: 409,
        ERR_VERIFICATION_FAILED: 422,
    },
}));

const TagsModule = require("../../Repositories/Tags/modules/tags.module");
const IPFS = require("../../Core/ipfs");

const { errorHandler } = require("../../Core/http-handler");

const {
    resolveZelfIdPasswordForOwnership,
    remapZelfKeyCaughtError,
    deleteZelfKey,
    _ownsZelfKey,
} = require("../../Repositories/ZelfKeys/modules/zelf-key.module");

const authToken = { tagName: "leaseuser", identifier: "leaseuser", domain: "zelf" };

describe("Zelf Keys ownership + error codes", () => {
    it("does not use site password for password-type store ownership", () => {
        expect(
            resolveZelfIdPasswordForOwnership({
                type: "password",
                password: "site-secret",
                masterPassword: "zelf-id-layer",
            }),
        ).toBe("zelf-id-layer");
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
        expect(errorHandler(new Error("401:ERR_INVALID_PASSWORD")).code).toBe("ERR_INVALID_PASSWORD");
    });

    it("maps missing password to 409 ERR_PASSWORD_REQUIRED", () => {
        expect(() => remapZelfKeyCaughtError(new Error("password is required"))).toThrow("409:ERR_PASSWORD_REQUIRED");
        expect(errorHandler(new Error("409:ERR_PASSWORD_REQUIRED")).code).toBe("ERR_PASSWORD_REQUIRED");
    });

    it("accepts masterPassword for extension v4 ownership on delete", () => {
        expect(
            resolveZelfIdPasswordForOwnership({
                masterPassword: "zelf-id-from-extension",
            }),
        ).toBe("zelf-id-from-extension");
    });

    it("prefers password over masterPassword when both are present (non-password store)", () => {
        expect(
            resolveZelfIdPasswordForOwnership({
                password: "explicit-zelf-id",
                masterPassword: "legacy-master",
            }),
        ).toBe("explicit-zelf-id");
    });

    it("maps liveness failures to 422 ERR_VERIFICATION_FAILED without matching generic face text", () => {
        expect(() => remapZelfKeyCaughtError(new Error("face is not central"))).toThrow("422:ERR_VERIFICATION_FAILED");
        expect(errorHandler(new Error("422:ERR_VERIFICATION_FAILED")).code).toBe("ERR_VERIFICATION_FAILED");
        expect(() => remapZelfKeyCaughtError(new Error("face metadata mismatch"))).toThrow("face metadata mismatch");
    });

    it("uses oldMasterPassword for change-master-password ownership", () => {
        expect(
            resolveZelfIdPasswordForOwnership({
                oldMasterPassword: "rotate-from-old",
                newMasterPassword: "rotate-to-new",
            }),
        ).toBe("rotate-from-old");
    });
});

describe("legacy keyOwner normalization", () => {
    it("treats x.zelf.zelf keyOwner as x.zelf for ownership", () => {
        const publicData = { keyOwner: "x.zelf.zelf", category: "x.zelf.zelf_password" };
        expect(_ownsZelfKey(publicData, "x.zelf", "zelf")).toBe(true);
    });
});

describe("deleteZelfKey ownership (_validateOwnership / decryptTag)", () => {
    beforeEach(() => {
        TagsModule.decryptTag.mockReset();
        IPFS.deleteFiles.mockClear();
        IPFS.getFileById.mockReset();
        IPFS.getFileById.mockResolvedValue({
            id: "pin-1",
            publicData: { keyOwner: "leaseuser.zelf", category: "leaseuser.zelf_password" },
        });
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

    it("accepts masterPassword for extension v4 on delete", async () => {
        TagsModule.decryptTag.mockResolvedValue({});

        await deleteZelfKey({ id: "pin-2", faceBase64: "face-data", masterPassword: "zelf-id-secret" }, authToken);

        expect(TagsModule.decryptTag).toHaveBeenCalledWith(
            expect.objectContaining({ password: "zelf-id-secret" }),
            authToken,
        );
    });

    it("rejects delete when the pin belongs to another Zelf ID", async () => {
        IPFS.getFileById.mockResolvedValueOnce({
            id: "pin-other",
            publicData: { keyOwner: "otheruser.zelf", category: "otheruser.zelf_password" },
        });

        await expect(deleteZelfKey({ id: "pin-other", faceBase64: "face-data" }, authToken)).rejects.toThrow(
            "403:Not authorized to delete this ZelfKey",
        );
        expect(TagsModule.decryptTag).not.toHaveBeenCalled();
        expect(IPFS.deleteFiles).not.toHaveBeenCalled();
    });

    it("rejects delete when decryptTag reports a face mismatch", async () => {
        TagsModule.decryptTag.mockRejectedValue(new Error("face not recognized"));

        await expect(deleteZelfKey({ id: "pin-3", faceBase64: "bad-face" }, authToken)).rejects.toThrow(
            "422:ERR_VERIFICATION_FAILED",
        );
        expect(IPFS.deleteFiles).not.toHaveBeenCalled();
    });
});
