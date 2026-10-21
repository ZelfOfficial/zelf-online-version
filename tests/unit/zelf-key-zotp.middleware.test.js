const Middleware = require("../../Repositories/ZelfKeys/middlewares/zelf-key.middleware");

describe("ZelfKeys store ZOTP middleware", () => {
    const basePayload = {
        username: "user@zelf.world",
        setupKey: "JBSWY3DPEHPK3PXP",
        issuer: "GitHub",
        faceBase64: "face-data",
    };

    it("normalizes setupKey on the request body", async () => {
        const ctx = {
            request: {
                body: {
                    ...basePayload,
                    setupKey: "jbsw-y3dp ehpk3pxp=",
                },
            },
        };
        let nextCalled = false;

        await Middleware.storeZOTPValidation(ctx, async () => {
            nextCalled = true;
        });

        expect(nextCalled).toBe(true);
        expect(ctx.request.body.setupKey).toBe("JBSWY3DPEHPK3PXP");
        expect(ctx.request.body).toMatchObject({
            algorithm: "SHA1",
            digits: 6,
            period: 30,
        });
    });

    it("returns ERR_INVALID_SETUP_KEY for invalid secrets", async () => {
        const ctx = {
            request: {
                body: {
                    ...basePayload,
                    setupKey: "not-valid-base32!",
                },
            },
        };

        await Middleware.storeZOTPValidation(ctx, async () => {});

        expect(ctx.status).toBe(409);
        expect(ctx.body.code).toBe("ERR_INVALID_SETUP_KEY");
        expect(ctx.body.validationError).toMatch(/Base32/i);
    });

    it("returns ERR_INVALID_TOTP_PARAMS for invalid digits", async () => {
        const ctx = {
            request: {
                body: {
                    ...basePayload,
                    digits: 9,
                },
            },
        };

        await Middleware.storeZOTPValidation(ctx, async () => {});

        expect(ctx.status).toBe(409);
        expect(ctx.body.code).toBe("ERR_INVALID_TOTP_PARAMS");
        expect(ctx.body.validationError).toMatch(/digits/i);
    });

    it("accepts custom TOTP parameters", async () => {
        const ctx = {
            request: {
                body: {
                    ...basePayload,
                    algorithm: "SHA512",
                    digits: 7,
                    period: 45,
                },
            },
        };
        let nextCalled = false;

        await Middleware.storeZOTPValidation(ctx, async () => {
            nextCalled = true;
        });

        expect(nextCalled).toBe(true);
        expect(ctx.request.body).toMatchObject({
            algorithm: "SHA512",
            digits: 7,
            period: 45,
        });
    });
});
