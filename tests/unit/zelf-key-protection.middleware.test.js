const Middleware = require("../../Repositories/ZelfKeys/middlewares/zelf-key.middleware");

describe("ZelfKeys protection middleware", () => {
    it("accepts valid protection values on store password", async () => {
        const ctx = {
            request: {
                body: {
                    website: "https://example.com",
                    username: "user@example.com",
                    password: "secret",
                    faceBase64: "face",
                    protection: "face_password",
                },
            },
        };
        let nextCalled = false;

        await Middleware.storePasswordValidation(ctx, async () => {
            nextCalled = true;
        });

        expect(nextCalled).toBe(true);
        expect(ctx.status).toBeUndefined();
    });

    it("rejects unknown protection values on store password", async () => {
        const ctx = {
            request: {
                body: {
                    website: "https://example.com",
                    username: "user@example.com",
                    password: "secret",
                    faceBase64: "face",
                    protection: "pin_only",
                },
            },
        };

        await Middleware.storePasswordValidation(ctx, async () => {});

        expect(ctx.status).toBe(409);
        expect(ctx.body.validationError).toMatch(/protection/i);
    });

    it("validates change-master-password payload", async () => {
        const ctx = {
            request: {
                body: {
                    faceBase64: "face",
                    oldMasterPassword: "old",
                    newMasterPassword: "new",
                },
            },
        };
        let nextCalled = false;

        await Middleware.changeMasterPasswordValidation(ctx, async () => {
            nextCalled = true;
        });

        expect(nextCalled).toBe(true);
    });

    it("accepts retrieve with masterPassword instead of password", async () => {
        const ctx = {
            request: {
                body: {
                    zelfProof: "proof",
                    faceBase64: "face",
                    masterPassword: "vault-password",
                    type: "zotp",
                    v: "4",
                },
            },
        };
        let nextCalled = false;

        await Middleware.retrieveValidation(ctx, async () => {
            nextCalled = true;
        });

        expect(nextCalled).toBe(true);
        expect(ctx.status).toBeUndefined();
    });

    it("rejects change-master-password without oldMasterPassword", async () => {
        const ctx = {
            request: {
                body: {
                    faceBase64: "face",
                    newMasterPassword: "new",
                },
            },
        };

        await Middleware.changeMasterPasswordValidation(ctx, async () => {});

        expect(ctx.status).toBe(409);
        expect(ctx.body.validationError).toMatch(/oldMasterPassword/i);
    });
});
