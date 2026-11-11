jest.mock("../../Repositories/ZelfProof/modules/zelf-proof.module", () => {
    const actual = jest.requireActual("../../Repositories/ZelfProof/modules/zelf-proof.module");
    return {
        ...actual,
        decrypt: jest.fn(),
        encryptQRCode: jest.fn(),
    };
});

jest.mock("../../Repositories/Session/modules/session.module", () => {
    const { normalizeZelfName } = jest.requireActual("../../Repositories/Tags/modules/zelf-name.util");
    return {
        sessionDecrypt: jest.fn(),
        markSessionIdentityVerified: jest.fn(),
        normalizeZelfName,
    };
});

jest.mock("../../Repositories/Wallet/modules/stored-zelf-proof.module", () => ({
    findStoredZelfProof: jest.fn(),
    proofsMatch: (left, right) => typeof left === "string" && typeof right === "string" && left.length > 0 && left === right,
}));

const ZelfProofModule = require("../../Repositories/ZelfProof/modules/zelf-proof.module");
const SessionModule = require("../../Repositories/Session/modules/session.module");
const StoredZelfProof = require("../../Repositories/Wallet/modules/stored-zelf-proof.module");
const WalletModule = require("../../Repositories/Wallet/modules/wallet.module");
const FaceWhitelist = require("../../Repositories/Face/modules/face-body-whitelist.module");

describe("MyWallets legacy decrypt & export (Issue #182)", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        SessionModule.sessionDecrypt.mockImplementation(async (value) => value);
        SessionModule.markSessionIdentityVerified.mockResolvedValue(undefined);
        StoredZelfProof.findStoredZelfProof.mockResolvedValue(null);
        ZelfProofModule.encryptQRCode.mockResolvedValue({ zelfQR: "qr-code" });
    });

    it("strips NO_PASSWORD_PLACEHOLDER for face-only wallet decrypt and marks session verified", async () => {
        StoredZelfProof.findStoredZelfProof.mockResolvedValue({
            zelfName: "legacy.zelf",
            zelfProof: "legacy-proof",
        });
        ZelfProofModule.decrypt.mockResolvedValueOnce({
            metadata: { mnemonic: "test mnemonic" },
            publicData: { zelfName: "legacy.zelf", v: "4" },
        });

        const result = await WalletModule.decryptWallet(
            {
                zelfProof: "legacy-proof",
                faceBase64: "face-b64",
                password: "NO_PASSWORD_PLACEHOLDER",
                skipQRCode: true,
                v: 4,
            },
            { session: "sess-1" },
        );

        expect(ZelfProofModule.decrypt).toHaveBeenCalledWith(
            expect.objectContaining({
                zelfProof: "legacy-proof",
                faceBase64: "face-b64",
                password: null,
                stack: "v4",
            }),
        );
        expect(SessionModule.markSessionIdentityVerified).toHaveBeenCalledWith(
            { session: "sess-1" },
            "legacy.zelf",
            "zelf",
        );
        expect(result.zelfProof).toBe("legacy-proof");
    });

    it("retries with real password when hasPassword hint is stale false and proof returns ERR_PASSWORD_REQUIRED", async () => {
        const passReqErr = new Error("ERR_PASSWORD_REQUIRED");
        passReqErr.code = "ERR_PASSWORD_REQUIRED";
        passReqErr.status = 409;

        ZelfProofModule.decrypt
            .mockRejectedValueOnce(passReqErr)
            .mockResolvedValueOnce({
                metadata: { mnemonic: "test mnemonic" },
                publicData: { zelfName: "qa.zelf", v: "4" },
            });

        const result = await WalletModule.decryptWallet(
            {
                zelfProof: "qa-proof",
                faceBase64: "face-b64",
                password: "real-secret",
                publicData: { hasPassword: "false", v: "4" },
                skipQRCode: true,
            },
            { session: "sess-1" },
        );

        expect(ZelfProofModule.decrypt).toHaveBeenCalledTimes(2);
        expect(ZelfProofModule.decrypt).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ password: null }),
        );
        expect(ZelfProofModule.decrypt).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ password: "real-secret" }),
        );
        expect(result.publicData.zelfName).toBe("qa.zelf");
        expect(SessionModule.markSessionIdentityVerified).not.toHaveBeenCalled();
    });

    it("returns an unregistered wallet decrypt without marking the session verified", async () => {
        ZelfProofModule.decrypt.mockResolvedValueOnce({
            metadata: { mnemonic: "local mnemonic" },
            publicData: { zelfName: "local.zelf" },
        });

        const result = await WalletModule.decryptWallet(
            {
                zelfProof: "local-proof",
                faceBase64: "face-b64",
                password: "secret",
                skipQRCode: true,
            },
            { session: "sess-1" },
        );

        expect(result.metadata.mnemonic).toBe("local mnemonic");
        expect(SessionModule.markSessionIdentityVerified).not.toHaveBeenCalled();
    });

    it("refuses a client blob that does not match the stored record and does not mark the session", async () => {
        StoredZelfProof.findStoredZelfProof.mockResolvedValue({
            zelfName: "victim.zelf",
            zelfProof: "stored-proof",
        });
        ZelfProofModule.decrypt.mockResolvedValueOnce({
            metadata: { mnemonic: "other mnemonic" },
            publicData: { zelfName: "victim.zelf" },
        });

        await expect(
            WalletModule.decryptWallet(
                {
                    zelfProof: "other-proof",
                    faceBase64: "face-b64",
                    password: "secret",
                    zelfName: "victim.zelf",
                    skipQRCode: true,
                },
                { session: "sess-1" },
            ),
        ).rejects.toMatchObject({
            status: 403,
            code: "ZELF_PROOF_MISMATCH",
        });
        expect(SessionModule.markSessionIdentityVerified).not.toHaveBeenCalled();
    });

    it("maps wrong password and face mismatch to 401 ERR_INVALID_PASSWORD and 422 ERR_VERIFICATION_FAILED", async () => {
        const badPass = new Error("ERR_INVALID_PASSWORD");
        badPass.code = "ERR_INVALID_PASSWORD";
        ZelfProofModule.decrypt.mockRejectedValueOnce(badPass);

        await expect(
            WalletModule.decryptWallet(
                {
                    zelfProof: "proof",
                    faceBase64: "face-b64",
                    password: "wrong",
                    v: 4,
                },
                {},
            ),
        ).rejects.toMatchObject({
            status: 401,
            code: "ERR_INVALID_PASSWORD",
        });

        const badFace = new Error("ERR_VERIFICATION_FAILED");
        badFace.code = "ERR_VERIFICATION_FAILED";
        ZelfProofModule.decrypt.mockRejectedValueOnce(badFace);

        await expect(
            WalletModule.decryptWallet(
                {
                    zelfProof: "proof",
                    faceBase64: "bad-face",
                    password: "right",
                    v: 4,
                },
                {},
            ),
        ).rejects.toMatchObject({
            status: 422,
            code: "ERR_VERIFICATION_FAILED",
        });
    });

    it("whitelists wallet-decrypt payload fields in face-body-whitelist", () => {
        const allowed = FaceWhitelist.ALLOWED_BY_ACTION["wallet-decrypt"];
        expect(allowed).toEqual(
            expect.arrayContaining([
                "faceBase64",
                "password",
                "zelfProof",
                "identifier",
                "addServerPassword",
                "zelfName",
                "domain",
                "skipQRCode",
            ]),
        );
    });
});
