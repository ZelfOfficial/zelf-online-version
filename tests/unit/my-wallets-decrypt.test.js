jest.mock("../../Repositories/ZelfProof/modules/zelf-proof.module", () => {
    const actual = jest.requireActual("../../Repositories/ZelfProof/modules/zelf-proof.module");
    return {
        ...actual,
        decrypt: jest.fn(),
        encryptQRCode: jest.fn(),
    };
});

jest.mock("../../Repositories/Session/modules/session.module", () => ({
    sessionDecrypt: jest.fn(),
    markSessionIdentityVerified: jest.fn(),
}));

const ZelfProofModule = require("../../Repositories/ZelfProof/modules/zelf-proof.module");
const SessionModule = require("../../Repositories/Session/modules/session.module");
const WalletModule = require("../../Repositories/Wallet/modules/wallet.module");
const FaceWhitelist = require("../../Repositories/Face/modules/face-body-whitelist.module");

describe("MyWallets legacy decrypt & export (Issue #182)", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        SessionModule.sessionDecrypt.mockImplementation(async (value) => value);
        SessionModule.markSessionIdentityVerified.mockResolvedValue(undefined);
        ZelfProofModule.encryptQRCode.mockResolvedValue({ zelfQR: "qr-code" });
    });

    it("strips NO_PASSWORD_PLACEHOLDER for face-only wallet decrypt and marks session verified", async () => {
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
            undefined,
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
