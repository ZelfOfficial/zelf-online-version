jest.mock("../../Repositories/Tags/modules/tags-parts.module", () => ({
    decryptParams: jest.fn(),
    decryptPasswordParams: jest.fn(),
    decryptCreditCardParams: jest.fn(),
    decryptNotesParams: jest.fn(),
    urlToBase64: jest.fn(),
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
        if (layer === "WithPassword" || layer === "Password") return true;
        if (layer === "WithoutPassword" || layer === "NoPassword") return false;
        return undefined;
    }),
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

const TagsPartsModule = require("../../Repositories/Tags/modules/tags-parts.module");
const TagsModule = require("../../Repositories/Tags/modules/tags.module");
const ZelfProofModule = require("../../Repositories/ZelfProof/modules/zelf-proof.module");
const QRZelfProofExtractor = require("../../Repositories/Tags/modules/qr-zelfproof-extractor.module");
const ZelfKeyModule = require("../../Repositories/ZelfKeys/modules/zelf-key.module");

describe("ZelfKeys protection helpers", () => {
    test("defaults missing protection to face for legacy keys", () => {
        expect(ZelfKeyModule.resolveProtection(undefined)).toBe("face");
        expect(ZelfKeyModule.resolveProtection("")).toBe("face");
        expect(ZelfKeyModule.resolveProtection("face")).toBe("face");
        expect(ZelfKeyModule.resolveProtection("face_password")).toBe("face_password");
    });

    test("requires key password only for face_password protection", () => {
        expect(ZelfKeyModule.protectionRequiresKeyPassword("face")).toBe(false);
        expect(ZelfKeyModule.protectionRequiresKeyPassword("face_password")).toBe(true);
    });
});

describe("ZelfKeys retrieve protection gating", () => {
    const authToken = { tagName: "alice", identifier: "alice", domain: "zelf" };

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, "error").mockImplementation(() => {});
        jest.spyOn(console, "warn").mockImplementation(() => {});

        TagsPartsModule.decryptParams.mockResolvedValue({
            face: "decrypted-face",
            password: "vault-password",
        });

        ZelfProofModule.preview.mockResolvedValue({
            publicData: { protection: "face", type: "zotp", v: "4" },
            passwordLayer: "WithoutPassword",
        });
        ZelfProofModule.previewWithLegacyFallback.mockResolvedValue({
            publicData: { protection: "face", type: "zotp" },
            passwordLayer: "WithoutPassword",
        });

        ZelfProofModule.decrypt.mockResolvedValue({
            metadata: { password: "site-secret" },
            publicData: { type: "password", protection: "face" },
        });
    });

    afterEach(() => {
        console.error.mockRestore();
        console.warn.mockRestore();
    });

    it("clears password for face-only keys before decrypt", async () => {
        await ZelfKeyModule.retrieveData(
            {
                zelfProof: "proof",
                faceBase64: "face",
                password: "vault-password",
                type: "zotp",
                protection: "face",
            },
            authToken,
        );

        expect(ZelfProofModule.decrypt).toHaveBeenCalledWith(
            expect.objectContaining({
                password: undefined,
            }),
        );
    });

    it("requires password for face_password keys", async () => {
        ZelfProofModule.preview.mockResolvedValue({
            publicData: { protection: "face_password", type: "password", v: "4" },
            passwordLayer: "WithPassword",
        });

        TagsPartsModule.decryptParams.mockResolvedValue({
            face: "decrypted-face",
            password: undefined,
        });

        await expect(
            ZelfKeyModule.retrieveData(
                {
                    zelfProof: "proof",
                    faceBase64: "face",
                    type: "password",
                    v: "4",
                },
                authToken,
            ),
        ).rejects.toThrow(/ERR_MISSING_PASSWORD/);

        expect(ZelfProofModule.decrypt).not.toHaveBeenCalled();
    });

    it("forwards password for face_password keys", async () => {
        ZelfProofModule.preview.mockResolvedValue({
            publicData: { protection: "face_password", type: "zotp", v: "4" },
            passwordLayer: "WithPassword",
        });

        await ZelfKeyModule.retrieveData(
            {
                zelfProof: "proof",
                faceBase64: "face",
                password: "vault-password",
                type: "zotp",
                v: "4",
            },
            authToken,
        );

        expect(ZelfProofModule.decrypt).toHaveBeenCalledWith(
            expect.objectContaining({
                password: "vault-password",
            }),
        );
    });

    it("uses stored protection when the request omits protection", async () => {
        ZelfProofModule.preview.mockResolvedValue({
            publicData: { protection: "face_password", type: "zotp", v: "4" },
            passwordLayer: "WithPassword",
        });

        await ZelfKeyModule.retrieveData(
            {
                zelfProof: "proof",
                faceBase64: "face",
                password: "vault-password",
                type: "zotp",
                v: "4",
            },
            authToken,
        );

        expect(ZelfProofModule.preview).toHaveBeenCalled();
        expect(ZelfProofModule.decrypt).toHaveBeenCalledWith(
            expect.objectContaining({
                password: "vault-password",
            }),
        );
    });

    it("does not let a face request hint override stored face_password", async () => {
        ZelfProofModule.preview.mockResolvedValue({
            publicData: { protection: "face_password", type: "zotp", v: "4" },
            passwordLayer: "WithPassword",
        });

        await ZelfKeyModule.retrieveData(
            {
                zelfProof: "proof",
                faceBase64: "face",
                password: "vault-password",
                type: "zotp",
                v: "4",
                protection: "face",
            },
            authToken,
        );

        expect(ZelfProofModule.decrypt).toHaveBeenCalledWith(
            expect.objectContaining({
                password: "vault-password",
            }),
        );
    });
});

describe("ZelfKeys store protection", () => {
    const authToken = { tagName: "alice", identifier: "alice", domain: "zelf" };

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, "error").mockImplementation(() => {});

        TagsPartsModule.decryptParams.mockResolvedValue({
            face: "decrypted-face",
            password: "vault-password",
        });
        TagsModule.decryptTag.mockResolvedValue({});
        TagsPartsModule.decryptPasswordParams.mockResolvedValue({ password: "site-secret" });
        ZelfProofModule.encrypt.mockResolvedValue({ zelfProof: "mock-proof" });
        QRZelfProofExtractor.generateQRFromZelfProof.mockResolvedValue("mock-qr");
    });

    afterEach(() => {
        console.error.mockRestore();
    });

    it("rejects face_password store without masterPassword", async () => {
        TagsPartsModule.decryptParams.mockResolvedValue({
            face: "decrypted-face",
            password: undefined,
        });

        await expect(
            ZelfKeyModule.storeData(
                {
                    type: "password",
                    website: "https://example.com",
                    username: "user@example.com",
                    password: "secret",
                    faceBase64: "face",
                    protection: "face_password",
                },
                authToken,
            ),
        ).rejects.toThrow(/master_password_required_for_face_password_protection/);

        expect(ZelfProofModule.encrypt).not.toHaveBeenCalled();
    });

    it("encrypts face_password keys with the master password", async () => {
        await ZelfKeyModule.storeData(
            {
                type: "password",
                website: "https://example.com",
                username: "user@example.com",
                password: "secret",
                faceBase64: "face",
                masterPassword: "vault-password",
                protection: "face_password",
                removePGP: true,
            },
            authToken,
        );

        expect(ZelfProofModule.encrypt).toHaveBeenCalledWith(
            expect.objectContaining({
                password: "vault-password",
                publicData: expect.objectContaining({
                    protection: "face_password",
                }),
            }),
        );
    });

    it("round-trips face_password store masterPassword into retrieve password", async () => {
        const keyPassword = "vault-password";
        let encryptedWithPassword = null;

        ZelfProofModule.encrypt.mockImplementation(async (payload) => {
            encryptedWithPassword = payload.password;
            return { zelfProof: "roundtrip-proof" };
        });

        await ZelfKeyModule.storeData(
            {
                type: "zotp",
                username: "user@example.com",
                setupKey: "JBSWY3DPEHPK3PXP",
                issuer: "GitHub",
                faceBase64: "face",
                masterPassword: keyPassword,
                protection: "face_password",
                removePGP: true,
            },
            authToken,
        );

        expect(encryptedWithPassword).toBe(keyPassword);

        ZelfProofModule.preview.mockResolvedValue({
            publicData: { protection: "face_password", type: "zotp", v: "4" },
            passwordLayer: "WithPassword",
        });

        await ZelfKeyModule.retrieveData(
            {
                zelfProof: "roundtrip-proof",
                faceBase64: "face",
                password: keyPassword,
                type: "zotp",
                v: "4",
                removePGP: true,
            },
            authToken,
        );

        expect(ZelfProofModule.decrypt).toHaveBeenCalledWith(
            expect.objectContaining({
                password: encryptedWithPassword,
            }),
        );
    });

    it("retrieve accepts masterPassword with the same unwrap path as store", async () => {
        ZelfProofModule.preview.mockResolvedValue({
            publicData: { protection: "face_password", type: "zotp", v: "4" },
            passwordLayer: "WithPassword",
        });

        await ZelfKeyModule.retrieveData(
            {
                zelfProof: "proof",
                faceBase64: "face",
                masterPassword: "vault-password",
                type: "zotp",
                v: "4",
                removePGP: true,
            },
            authToken,
        );

        expect(TagsPartsModule.decryptParams).toHaveBeenCalledWith(
            expect.objectContaining({
                password: "vault-password",
            }),
            authToken,
        );
        expect(ZelfProofModule.decrypt).toHaveBeenCalledWith(
            expect.objectContaining({
                password: "vault-password",
            }),
        );
    });

    it("stores face-only keys without a proof password", async () => {
        TagsPartsModule.decryptParams.mockResolvedValue({
            face: "decrypted-face",
            password: undefined,
        });

        await ZelfKeyModule.storeData(
            {
                type: "password",
                website: "https://example.com",
                username: "user@example.com",
                password: "secret",
                faceBase64: "face",
                protection: "face",
                removePGP: true,
            },
            authToken,
        );

        expect(ZelfProofModule.encrypt).toHaveBeenCalledWith(
            expect.objectContaining({
                password: undefined,
                publicData: expect.objectContaining({
                    protection: "face",
                }),
            }),
        );
    });
});
