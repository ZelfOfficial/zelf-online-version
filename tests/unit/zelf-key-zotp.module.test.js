const {
    normalizeSetupKey,
    resolveZotpTotpParams,
    withZotpTotpDefaults,
    formatZotpTotpPublicDataFields,
    ZOTP_DEFAULT_ALGORITHM,
    ZOTP_DEFAULT_DIGITS,
    ZOTP_DEFAULT_PERIOD,
} = require("../../Repositories/ZelfKeys/modules/zelf-key-zotp.module");

describe("ZelfKey ZOTP module", () => {
    describe("normalizeSetupKey", () => {
        it("normalizes spacing, dashes, padding, and case", () => {
            const result = normalizeSetupKey("  jbsw y3dp-ehpk3pxp=  ");
            expect(result.normalized).toBe("JBSWY3DPEHPK3PXP");
        });

        it("rejects keys shorter than 16 Base32 characters", () => {
            const result = normalizeSetupKey("JBSWY3DPEHPK3PX");
            expect(result.code).toBe("ERR_INVALID_SETUP_KEY");
            expect(result.message).toMatch(/16/);
        });

        it("rejects non-Base32 characters", () => {
            const result = normalizeSetupKey("JBSWY3DPEHPK3PXP0");
            expect(result.code).toBe("ERR_INVALID_SETUP_KEY");
            expect(result.message).toMatch(/Base32/i);
        });
    });

    describe("resolveZotpTotpParams", () => {
        it("applies defaults when params are omitted", () => {
            expect(resolveZotpTotpParams({})).toEqual({
                algorithm: ZOTP_DEFAULT_ALGORITHM,
                digits: ZOTP_DEFAULT_DIGITS,
                period: ZOTP_DEFAULT_PERIOD,
            });
        });

        it("accepts explicit TOTP parameters", () => {
            expect(
                resolveZotpTotpParams({
                    algorithm: "sha256",
                    digits: "8",
                    period: 60,
                })
            ).toEqual({
                algorithm: "SHA256",
                digits: 8,
                period: 60,
            });
        });

        it("rejects invalid algorithm", () => {
            const result = resolveZotpTotpParams({ algorithm: "MD5" });
            expect(result.error.code).toBe("ERR_INVALID_TOTP_PARAMS");
        });

        it("rejects digits outside 6–8", () => {
            const result = resolveZotpTotpParams({ digits: 5 });
            expect(result.error.code).toBe("ERR_INVALID_TOTP_PARAMS");
        });
    });

    describe("formatZotpTotpPublicDataFields", () => {
        it("stringifies digits and period for ZelfProof storage", () => {
            expect(
                formatZotpTotpPublicDataFields({
                    algorithm: "SHA256",
                    digits: 8,
                    period: 60,
                })
            ).toEqual({
                algorithm: "SHA256",
                digits: "8",
                period: "60",
            });
        });
    });

    describe("withZotpTotpDefaults", () => {
        it("parses string digits/period from stored publicData", () => {
            expect(
                withZotpTotpDefaults({
                    type: "zotp",
                    algorithm: "SHA512",
                    digits: "7",
                    period: "45",
                })
            ).toMatchObject({
                algorithm: "SHA512",
                digits: 7,
                period: 45,
            });
        });

        it("fills defaults for zotp publicData only", () => {
            expect(withZotpTotpDefaults({ type: "password" })).toEqual({ type: "password" });
            expect(withZotpTotpDefaults({ type: "zotp", issuer: "GitHub" })).toEqual({
                type: "zotp",
                issuer: "GitHub",
                algorithm: ZOTP_DEFAULT_ALGORITHM,
                digits: ZOTP_DEFAULT_DIGITS,
                period: ZOTP_DEFAULT_PERIOD,
            });
        });
    });
});
