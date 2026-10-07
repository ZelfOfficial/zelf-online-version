jest.mock("../../Repositories/Tags/modules/tags-parts.module", () => ({
    decryptParams: jest.fn(),
    urlToBase64: jest.fn(),
    getFullTagName: jest.fn((identifier, domain) => `${identifier}.${domain}`),
}));

jest.mock("../../Repositories/Tags/modules/tags.module", () => ({
    decryptTag: jest.fn(),
}));

jest.mock("../../Repositories/ZelfProof/modules/zelf-proof.module", () => ({
    encrypt: jest.fn(),
    decrypt: jest.fn(),
}));

jest.mock("../../Repositories/Tags/modules/qr-zelfproof-extractor.module", () => ({
    generateQRFromZelfProof: jest.fn(),
    extractZelfProofFromQR: jest.fn(),
}));

jest.mock("../../Core/ipfs", () => ({
    pinFile: jest.fn(),
    filter: jest.fn(),
    deleteFiles: jest.fn(),
}));

const TagsPartsModule = require("../../Repositories/Tags/modules/tags-parts.module");
const TagsModule = require("../../Repositories/Tags/modules/tags.module");
const ZelfProofModule = require("../../Repositories/ZelfProof/modules/zelf-proof.module");
const QRZelfProofExtractor = require("../../Repositories/Tags/modules/qr-zelfproof-extractor.module");
const IPFS = require("../../Core/ipfs");
const ZelfKeyModule = require("../../Repositories/ZelfKeys/modules/zelf-key.module");

describe("ZelfKeys changeMasterPassword", () => {
    const authToken = { tagName: "alice", identifier: "alice", domain: "zelf" };

    const facePasswordItem = {
        id: "pin-face-password",
        name: "alice.zelf_H1M2",
        url: "https://gateway.example/ipfs/cid-face-password",
        publicData: {
            category: "alice.zelf_password",
            keyOwner: "alice.zelf",
            protection: "face_password",
            type: "password",
            v: "4",
        },
    };

    const faceOnlyItem = {
        id: "pin-face-only",
        name: "alice.zelf_H1M3",
        url: "https://gateway.example/ipfs/cid-face-only",
        publicData: {
            category: "alice.zelf_password",
            keyOwner: "alice.zelf",
            protection: "face",
            type: "password",
            v: "4",
        },
    };

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, "error").mockImplementation(() => {});

        TagsPartsModule.decryptParams.mockImplementation(async (params) => {
            if (params.password === "old-secret") {
                return { face: "decrypted-face", password: "old-secret" };
            }
            if (params.password === "new-secret") {
                return { password: "new-secret" };
            }
            return { face: "decrypted-face", password: params.password };
        });

        TagsModule.decryptTag.mockResolvedValue({});
        TagsPartsModule.urlToBase64.mockResolvedValue("qr-image");
        QRZelfProofExtractor.extractZelfProofFromQR.mockResolvedValue("existing-proof");
        ZelfProofModule.decrypt.mockResolvedValue({
            metadata: { password: "site-secret" },
            publicData: facePasswordItem.publicData,
        });
        ZelfProofModule.encrypt.mockResolvedValue({ zelfProof: "reencrypted-proof" });
        QRZelfProofExtractor.generateQRFromZelfProof.mockResolvedValue("reencrypted-qr");
        IPFS.pinFile.mockResolvedValue({ id: "new-pin-id" });
        IPFS.deleteFiles.mockResolvedValue({ success: true });
        IPFS.filter.mockResolvedValue([facePasswordItem, faceOnlyItem]);
    });

    afterEach(() => {
        console.error.mockRestore();
    });

    it("re-encrypts only face_password keys and replaces IPFS pins", async () => {
        const result = await ZelfKeyModule.changeMasterPassword(
            {
                faceBase64: "face",
                oldMasterPassword: "old-secret",
                newMasterPassword: "new-secret",
                removePGP: true,
            },
            authToken,
        );

        expect(TagsModule.decryptTag).toHaveBeenCalledTimes(1);
        expect(ZelfProofModule.decrypt).toHaveBeenCalledTimes(1);
        expect(ZelfProofModule.encrypt).toHaveBeenCalledWith(
            expect.objectContaining({
                password: "new-secret",
                publicData: expect.objectContaining({ protection: "face_password" }),
            }),
        );
        expect(IPFS.pinFile).toHaveBeenCalledTimes(1);
        expect(IPFS.deleteFiles).toHaveBeenCalledWith(["pin-face-password"]);
        expect(result.updatedCount).toBe(1);
        expect(result.skippedCount).toBe(1);
    });

    it("returns success with zero updates when no face_password keys exist", async () => {
        IPFS.filter.mockResolvedValue([faceOnlyItem]);

        const result = await ZelfKeyModule.changeMasterPassword(
            {
                faceBase64: "face",
                oldMasterPassword: "old-secret",
                newMasterPassword: "new-secret",
                removePGP: true,
            },
            authToken,
        );

        expect(result.updatedCount).toBe(0);
        expect(result.skippedCount).toBe(1);
        expect(ZelfProofModule.decrypt).not.toHaveBeenCalled();
        expect(IPFS.pinFile).not.toHaveBeenCalled();
    });

    it("rolls back new pins when delete fails", async () => {
        IPFS.deleteFiles.mockImplementation(async (ids) => {
            if (ids.includes("pin-face-password")) {
                throw new Error("delete failed");
            }
            return { success: true };
        });

        await expect(
            ZelfKeyModule.changeMasterPassword(
                {
                    faceBase64: "face",
                    oldMasterPassword: "old-secret",
                    newMasterPassword: "new-secret",
                    removePGP: true,
                },
                authToken,
            ),
        ).rejects.toThrow(/failed_to_apply_master_password_change/);

        expect(IPFS.pinFile).toHaveBeenCalledTimes(1);
        expect(IPFS.deleteFiles).toHaveBeenCalledWith(["new-pin-id"]);
    });

    it("rejects identical old and new passwords", async () => {
        TagsPartsModule.decryptParams.mockImplementation(async (params) => {
            if (params.password === "same-secret") {
                return { face: "decrypted-face", password: "same-secret" };
            }
            return { password: "same-secret" };
        });

        await expect(
            ZelfKeyModule.changeMasterPassword(
                {
                    faceBase64: "face",
                    oldMasterPassword: "same-secret",
                    newMasterPassword: "same-secret",
                    removePGP: true,
                },
                authToken,
            ),
        ).rejects.toThrow(/new_master_password_must_differ/);
    });
});
