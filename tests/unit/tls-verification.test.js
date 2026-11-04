const { TLS_VERIFICATION_DISABLED_WARNING, warnIfTlsVerificationDisabled } = require("../../Core/tls-verification");

describe("TLS verification startup warning", () => {
    const capture = () => {
        const warnings = [];
        return {
            warnings,
            logger: {
                warn: (message) => warnings.push(message),
            },
        };
    };

    it("warns in production when NODE_TLS_REJECT_UNAUTHORIZED is 0 and does not throw", () => {
        const { warnings, logger } = capture();

        const warned = warnIfTlsVerificationDisabled(
            { NODE_ENV: "production", NODE_TLS_REJECT_UNAUTHORIZED: "0" },
            logger
        );

        expect(warned).toBe(true);
        expect(warnings).toEqual([TLS_VERIFICATION_DISABLED_WARNING]);
        expect(warnings[0]).toMatch(/Startup continues/);
    });

    it("stays quiet in production when the variable is unset", () => {
        const { warnings, logger } = capture();

        expect(warnIfTlsVerificationDisabled({ NODE_ENV: "production" }, logger)).toBe(false);
        expect(warnings).toEqual([]);
    });

    it("stays quiet outside production even when the variable is 0", () => {
        const { warnings, logger } = capture();

        expect(
            warnIfTlsVerificationDisabled({ NODE_ENV: "development", NODE_TLS_REJECT_UNAUTHORIZED: "0" }, logger)
        ).toBe(false);
        expect(warnIfTlsVerificationDisabled({ NODE_ENV: "test", NODE_TLS_REJECT_UNAUTHORIZED: "0" }, logger)).toBe(false);
        expect(warnings).toEqual([]);
    });

    it("stays quiet when certificate checks are left on", () => {
        const { warnings, logger } = capture();

        expect(warnIfTlsVerificationDisabled({ NODE_ENV: "production", NODE_TLS_REJECT_UNAUTHORIZED: "1" }, logger)).toBe(false);
        expect(warnings).toEqual([]);
    });
});
