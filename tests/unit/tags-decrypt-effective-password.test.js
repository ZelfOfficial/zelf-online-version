/**
 * Tags decrypt parity with ZelfID #147: face-only password stripping + distinct error statuses.
 */
const {
    NO_PASSWORD_PLACEHOLDER,
    effectivePassword,
} = require("../../Repositories/ZelfID/modules/zelf-id-password.module");
const {
    _formattingError,
    ZELFPROOF_CLIENT_ERROR_STATUS,
} = require("../../Repositories/ZelfProof/modules/zelf-proof.module");

describe("Tags decrypt #50 — effectivePassword reuse + distinct statuses", () => {
    it("strips password for face-only / placeholder / withoutPassword (same rules Tags now applies)", () => {
        expect(effectivePassword({ password: NO_PASSWORD_PLACEHOLDER })).toBeNull();
        expect(effectivePassword({ password: "x", securityType: "withoutPassword" })).toBeNull();
        expect(effectivePassword({ password: "x", hasPassword: "false" })).toBeNull();
        expect(effectivePassword({ password: "x", hasPassword: false })).toBeNull();
        expect(effectivePassword({ password: "secret", hasPassword: "true", securityType: "securePassword" })).toBe(
            "secret"
        );
        expect(effectivePassword({ password: "123456", securityType: "pin" })).toBe("123456");
    });

    it("maps wrong password, face mismatch, and password-required to distinct HTTP statuses", () => {
        expect(ZELFPROOF_CLIENT_ERROR_STATUS.ERR_INVALID_PASSWORD).toBe(401);
        expect(ZELFPROOF_CLIENT_ERROR_STATUS.ERR_PASSWORD_REQUIRED).toBe(409);
        expect(ZELFPROOF_CLIENT_ERROR_STATUS.ERR_VERIFICATION_FAILED).toBe(422);

        expect(_formattingError({ code: "ERR_INVALID_PASSWORD", message: "x", status: 500 }).status).toBe(401);
        expect(_formattingError({ code: "ERR_PASSWORD_REQUIRED", message: "x", status: 500 }).status).toBe(409);
        expect(_formattingError({ code: "ERR_VERIFICATION_FAILED", message: "x", status: 500 }).status).toBe(422);
    });
});
