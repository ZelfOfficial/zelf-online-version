/**
 * ZOTP (TOTP secret) helpers — setup key normalization and public TOTP parameters.
 */

const ZOTP_ALGORITHMS = ["SHA1", "SHA256", "SHA512"];
const ZOTP_DEFAULT_ALGORITHM = "SHA1";
const ZOTP_DEFAULT_DIGITS = 6;
const ZOTP_DEFAULT_PERIOD = 30;
const ZOTP_MAX_PERIOD = 300;
/** Pinata allows at most 9 metadata keyvalues per pin. */
const PINATA_MAX_KEYVALUES_PER_PIN = 9;

const BASE32_PATTERN = /^[A-Z2-7]+$/;

/**
 * Build an error that `Core/http-handler` maps to HTTP 409 with an `ERR_*` code.
 * @param {string} code
 * @param {string} message
 * @returns {Error}
 */
const createZotpValidationError = (code, message) => {
    const error = new Error(`409:${code}`);
    error.clientCode = code;
    error.clientMessage = message;
    return error;
};

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
 * TOTP fields stored in encrypted metadata (string values for ZelfProof).
 * @param {{ algorithm: string, digits: number, period: number }} resolved
 */
const formatZotpTotpMetadataFields = (resolved) => ({
    algorithm: `${resolved.algorithm}`,
    digits: `${resolved.digits}`,
    period: `${resolved.period}`,
});

/**
 * Resolve TOTP params for API responses (numeric digits/period).
 * @param {Object} publicData
 * @param {Object} [metadata]
 */
const resolveZotpTotpForRetrieve = (publicData, metadata) => {
    if (!publicData || publicData.type !== "zotp") {
        return null;
    }

    const resolved = resolveZotpTotpParams({
        algorithm: metadata?.algorithm ?? publicData?.algorithm,
        digits: metadata?.digits ?? publicData?.digits,
        period: metadata?.period ?? publicData?.period,
    });

    if (resolved.error) {
        return {
            algorithm: ZOTP_DEFAULT_ALGORITHM,
            digits: ZOTP_DEFAULT_DIGITS,
            period: ZOTP_DEFAULT_PERIOD,
        };
    }

    return {
        algorithm: resolved.algorithm,
        digits: resolved.digits,
        period: resolved.period,
    };
};

/**
 * @deprecated Legacy publicData-only helper; prefer resolveZotpTotpForRetrieve.
 */
const withZotpTotpDefaults = (publicData) => {
    const totp = resolveZotpTotpForRetrieve(publicData, {});
    if (!totp) {
        return publicData;
    }

    return {
        ...publicData,
        ...totp,
    };
};

/**
 * Build resolved TOTP params and string metadata fields for zOTP store.
 * @param {Object} data store request body (after middleware normalization)
 */
const resolveZotpTotpMetadataFields = (data) => {
    const resolved = resolveZotpTotpParams(data);
    if (resolved.error) {
        return resolved;
    }

    return {
        resolved,
        metadataFields: formatZotpTotpMetadataFields(resolved),
    };
};

const countPinKeyvalues = (keyvalues) =>
    Object.keys(keyvalues || {}).filter((key) => {
        const value = keyvalues[key];
        return value !== undefined && value !== null && value !== "";
    }).length;

/**
 * Keyvalue payloads passed to IPFS.pinFile during zOTP store (_store + saveZelfKey).
 * @param {Object} publicData stamped public metadata (no TOTP fields)
 * @param {{ identifier?: string, walrusBlobId?: string }} options
 */
const buildZotpStorePinKeyvaluePayloads = (publicData, options = {}) => {
    const { identifier = "zelfkey_pin_placeholder", walrusBlobId } = options;
    const saveZelfKeyPayload = { ...publicData };

    if (walrusBlobId) {
        saveZelfKeyPayload.walrus = walrusBlobId;
    }

    return {
        saveZelfKey: saveZelfKeyPayload,
        qrCode: {
            ...publicData,
            identifier,
        },
    };
};

module.exports = {
    ZOTP_ALGORITHMS,
    ZOTP_DEFAULT_ALGORITHM,
    ZOTP_DEFAULT_DIGITS,
    ZOTP_DEFAULT_PERIOD,
    ZOTP_MAX_PERIOD,
    PINATA_MAX_KEYVALUES_PER_PIN,
    createZotpValidationError,
    normalizeSetupKey,
    resolveZotpTotpParams,
    formatZotpTotpMetadataFields,
    resolveZotpTotpMetadataFields,
    resolveZotpTotpForRetrieve,
    withZotpTotpDefaults,
    countPinKeyvalues,
    buildZotpStorePinKeyvaluePayloads,
};
