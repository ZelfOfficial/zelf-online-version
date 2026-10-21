const {
    normalizeSetupKey,
    resolveZotpTotpParams,
    withZotpTotpDefaults,
    resolveZotpTotpForRetrieve,
    formatZotpTotpMetadataFields,
    buildZotpStorePinKeyvaluePayloads,
    countPinKeyvalues,
    PINATA_MAX_KEYVALUES_PER_PIN,
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

    describe("formatZotpTotpMetadataFields", () => {
        it("stringifies digits and period for encrypted metadata", () => {
            expect(
                formatZotpTotpMetadataFields({
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

    describe("resolveZotpTotpForRetrieve", () => {
        it("reads TOTP params from metadata with numeric defaults for legacy rows", () => {
            expect(
                resolveZotpTotpForRetrieve(
                    { type: "zotp", issuer: "GitHub" },
                    { setupKey: "JBSWY3DPEHPK3PXP", username: "user@zelf.world" }
                )
            ).toMatchObject({
                algorithm: ZOTP_DEFAULT_ALGORITHM,
                digits: ZOTP_DEFAULT_DIGITS,
                period: ZOTP_DEFAULT_PERIOD,
            });
        });

        it("parses metadata strings for clients", () => {
            expect(
                resolveZotpTotpForRetrieve(
                    { type: "zotp" },
                    { algorithm: "SHA512", digits: "7", period: "45" }
                )
            ).toMatchObject({
                algorithm: "SHA512",
                digits: 7,
                period: 45,
            });
        });
    });

    describe("buildZotpStorePinKeyvaluePayloads", () => {
        it("counts save + QR pin payloads within Pinata limit for default zOTP publicData", () => {
            const publicData = {
                category: "alice.zelf_zotp",
                issuer: "GitHub",
                keyOwner: "alice.zelf",
                protection: "face",
                type: "zotp",
                username: "user@zelf.world",
                v: "4",
            };
            const payloads = buildZotpStorePinKeyvaluePayloads(publicData, {
                identifier: "alice.zelf_123456",
                walrusBlobId: "blob",
            });

            expect(countPinKeyvalues(payloads.saveZelfKey)).toBeLessThanOrEqual(PINATA_MAX_KEYVALUES_PER_PIN);
            expect(countPinKeyvalues(payloads.qrCode)).toBeLessThanOrEqual(PINATA_MAX_KEYVALUES_PER_PIN);
        });
    });
});
