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
                    masterPassword: "vault-password",
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

    it("returns ERR_MISSING_PASSWORD for face_password store without masterPassword", async () => {
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

        expect(nextCalled).toBe(false);
        expect(ctx.status).toBe(400);
        expect(ctx.body).toEqual({ message: "ERR_MISSING_PASSWORD", code: "ERR_MISSING_PASSWORD" });
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
        expect(ctx.request.body.masterPassword).toBe("vault-password");
    });

    it("returns ERR_MISSING_PASSWORD for face_password zOTP retrieve with a whitespace password", async () => {
        const ctx = {
            request: {
                body: {
                    zelfProof: "proof",
                    faceBase64: "face",
                    password: "   ",
                    type: "zotp",
                    v: "4",
                    protection: "face_password",
                },
            },
        };
        let nextCalled = false;

        await Middleware.retrieveValidation(ctx, async () => {
            nextCalled = true;
        });

        expect(nextCalled).toBe(false);
        expect(ctx.status).toBe(400);
        expect(ctx.body).toEqual({ message: "ERR_MISSING_PASSWORD", code: "ERR_MISSING_PASSWORD" });
    });

    it("returns ERR_MISSING_PASSWORD for face_password retrieve when publicData protection has a whitespace masterPassword", async () => {
        const ctx = {
            request: {
                body: {
                    zelfProof: "proof",
                    faceBase64: "face",
                    masterPassword: " \t\n ",
                    type: "password",
                    v: "4",
                    publicData: { protection: "face_password", type: "password" },
                },
            },
        };
        let nextCalled = false;

        await Middleware.retrieveValidation(ctx, async () => {
            nextCalled = true;
        });

        expect(nextCalled).toBe(false);
        expect(ctx.status).toBe(400);
        expect(ctx.body.code).toBe("ERR_MISSING_PASSWORD");
    });

    it("returns ERR_MISSING_PASSWORD for face_password retrieve with an empty password", async () => {
        const ctx = {
            request: {
                body: {
                    zelfProof: "proof",
                    faceBase64: "face",
                    password: "",
                    type: "zotp",
                    protection: "face_password",
                },
            },
        };
        let nextCalled = false;

        await Middleware.retrieveValidation(ctx, async () => {
            nextCalled = true;
        });

        expect(nextCalled).toBe(false);
        expect(ctx.status).toBe(400);
        expect(ctx.body.code).toBe("ERR_MISSING_PASSWORD");
    });

    it("keeps right and wrong retrieve passwords unchanged, including surrounding spaces", async () => {
        const cases = ["vault-password", "wrong-password", " vault "];

        for (const password of cases) {
            const ctx = {
                request: {
                    body: {
                        zelfProof: "proof",
                        faceBase64: "face",
                        password,
                        type: "zotp",
                        protection: "face_password",
                    },
                },
            };
            let nextCalled = false;

            await Middleware.retrieveValidation(ctx, async () => {
                nextCalled = true;
            });

            expect(nextCalled).toBe(true);
            expect(ctx.status).toBeUndefined();
            expect(ctx.request.body.password).toBe(password);
        }
    });

    it("normalizes a whitespace retrieve password when protection is not face_password", async () => {
        const ctx = {
            request: {
                body: {
                    zelfProof: "proof",
                    faceBase64: "face",
                    password: "   ",
                    type: "zotp",
                    protection: "face",
                },
            },
        };
        let nextCalled = false;

        await Middleware.retrieveValidation(ctx, async () => {
            nextCalled = true;
        });

        expect(nextCalled).toBe(true);
        expect(ctx.status).toBeUndefined();
        expect(ctx.request.body.password).toBe("");
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
