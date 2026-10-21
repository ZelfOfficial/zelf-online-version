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

const {
    resolveZelfIdPasswordForOwnership,
    remapZelfKeyCaughtError,
} = require("../../Repositories/ZelfKeys/modules/zelf-key.module");

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
