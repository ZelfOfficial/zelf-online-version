/**
 * ZOTP (TOTP secret) helpers — setup key normalization and public TOTP parameters.
 */

const ZOTP_ALGORITHMS = ["SHA1", "SHA256", "SHA512"];
const ZOTP_DEFAULT_ALGORITHM = "SHA1";
const ZOTP_DEFAULT_DIGITS = 6;
const ZOTP_DEFAULT_PERIOD = 30;
const ZOTP_MAX_PERIOD = 300;

const BASE32_PATTERN = /^[A-Z2-7]+$/;

/**
 * Normalize a TOTP setup key for storage (uppercase Base32, no spaces, dashes, or padding).
 * @param {string} raw
 * @returns {{ normalized?: string, code: string, message: string }}
 */
const normalizeSetupKey = (raw) => {
    if (raw === undefined || raw === null) {
        return {
            code: "ERR_INVALID_SETUP_KEY",
            message: "setupKey is required",
        };
    }

    if (typeof raw !== "string") {
        return {
            code: "ERR_INVALID_SETUP_KEY",
            message: "setupKey must be a string",
        };
    }

    const normalized = raw
        .replace(/\s+/g, "")
        .replace(/-/g, "")
        .replace(/=+$/g, "")
        .toUpperCase();

    if (normalized.length < 16) {
        return {
            code: "ERR_INVALID_SETUP_KEY",
            message: "setupKey must be at least 16 Base32 characters after normalization",
        };
    }

    if (!BASE32_PATTERN.test(normalized)) {
        return {
            code: "ERR_INVALID_SETUP_KEY",
            message: "setupKey must contain only Base32 characters (A–Z and 2–7) after normalization",
        };
    }

    return { normalized, code: null, message: null };
};

const parsePositiveInt = (value, fieldName, { min, max }) => {
    if (value === undefined || value === null || value === "") {
        return { value: undefined };
    }

    let parsed = value;
    if (typeof value === "string") {
        if (!/^\d+$/.test(value.trim())) {
            return {
                code: "ERR_INVALID_TOTP_PARAMS",
                message: `${fieldName} must be a positive integer`,
            };
        }
        parsed = Number.parseInt(value.trim(), 10);
    }

    if (!Number.isInteger(parsed) || parsed < min || (max !== undefined && parsed > max)) {
        const range =
            max !== undefined ? `between ${min} and ${max}` : `at least ${min}`;
        return {
            code: "ERR_INVALID_TOTP_PARAMS",
            message: `${fieldName} must be ${range}`,
        };
    }

    return { value: parsed };
};

/**
 * Validate optional TOTP parameters from a store request body.
 * @param {Object} data
 * @returns {{ algorithm: string, digits: number, period: number, error?: { code: string, message: string } }}
 */
const resolveZotpTotpParams = (data) => {
    const algorithmRaw = data?.algorithm;
    let algorithm = ZOTP_DEFAULT_ALGORITHM;

    if (algorithmRaw !== undefined && algorithmRaw !== null && algorithmRaw !== "") {
        const normalizedAlgorithm = `${algorithmRaw}`.trim().toUpperCase();
        if (!ZOTP_ALGORITHMS.includes(normalizedAlgorithm)) {
            return {
                error: {
                    code: "ERR_INVALID_TOTP_PARAMS",
                    message: `algorithm must be one of: ${ZOTP_ALGORITHMS.join(", ")}`,
                },
            };
        }
        algorithm = normalizedAlgorithm;
    }

    const digitsResult = parsePositiveInt(data?.digits, "digits", { min: 6, max: 8 });
    if (digitsResult.code) {
        return { error: { code: digitsResult.code, message: digitsResult.message } };
    }

    const periodResult = parsePositiveInt(data?.period, "period", { min: 1, max: ZOTP_MAX_PERIOD });
    if (periodResult.code) {
        return { error: { code: periodResult.code, message: periodResult.message } };
    }

    return {
        algorithm,
        digits: digitsResult.value ?? ZOTP_DEFAULT_DIGITS,
        period: periodResult.value ?? ZOTP_DEFAULT_PERIOD,
    };
};

/**
 * TOTP fields as stored on ZelfProof publicData (cleartext values must be strings).
 * @param {{ algorithm: string, digits: number, period: number }} resolved
 */
const formatZotpTotpPublicDataFields = (resolved) => ({
    algorithm: `${resolved.algorithm}`,
    digits: `${resolved.digits}`,
    period: `${resolved.period}`,
});

/**
 * Apply default TOTP public fields for list/retrieve (legacy records may omit them).
 * @param {Object} publicData
 * @returns {Object}
 */
const withZotpTotpDefaults = (publicData) => {
    if (!publicData || publicData.type !== "zotp") {
        return publicData;
    }

    const algorithmRaw = publicData.algorithm;
    const algorithm =
        typeof algorithmRaw === "string" && ZOTP_ALGORITHMS.includes(algorithmRaw.toUpperCase())
            ? algorithmRaw.toUpperCase()
            : ZOTP_DEFAULT_ALGORITHM;

    const digitsParsed = parsePositiveInt(publicData.digits, "digits", { min: 6, max: 8 });
    const periodParsed = parsePositiveInt(publicData.period, "period", { min: 1, max: ZOTP_MAX_PERIOD });

    return {
        ...publicData,
        algorithm,
        digits: digitsParsed.value ?? ZOTP_DEFAULT_DIGITS,
        period: periodParsed.value ?? ZOTP_DEFAULT_PERIOD,
    };
};

/**
 * Build resolved TOTP params and string publicData fields for zOTP store.
 * @param {Object} data store request body (after middleware normalization)
 */
const resolveZotpTotpPublicDataFields = (data) => {
    const resolved = resolveZotpTotpParams(data);
    if (resolved.error) {
        return resolved;
    }

    return {
        resolved,
        publicFields: formatZotpTotpPublicDataFields(resolved),
    };
};

module.exports = {
    ZOTP_ALGORITHMS,
    ZOTP_DEFAULT_ALGORITHM,
    ZOTP_DEFAULT_DIGITS,
    ZOTP_DEFAULT_PERIOD,
    ZOTP_MAX_PERIOD,
    normalizeSetupKey,
    resolveZotpTotpParams,
    formatZotpTotpPublicDataFields,
    resolveZotpTotpPublicDataFields,
    withZotpTotpDefaults,
};
