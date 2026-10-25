const ZelfProofModule = require("../../ZelfProof/modules/zelf-proof.module");

/**
 * Map wallet / ZNS encrypt payloads to zelf-proof.module shape (public /zelf/* URLs).
 * @param {Object} data
 * @returns {Object}
 */
const _toZelfProofPayload = (data) => ({
    publicData: data.publicData ?? data.cleartext_data,
    faceBase64: data.faceBase64,
    metadata: data.metadata,
    password: data.password,
    identifier: data.identifier,
    record_id: data.record_id,
    _id: data._id,
    requireLiveness: data.requireLiveness ?? data.require_live_face ?? true,
    tolerance: data.tolerance,
    verifierKey: data.verifierKey,
    addServerPassword: data.addServerPassword,
    os: data.os,
    generateZelfProof: data.generateZelfProof,
    check_live_face_before_creation: data.check_live_face_before_creation,
});

const encrypt = async (data) => {
    try {
        const { zelfProof } = await ZelfProofModule.encrypt(_toZelfProofPayload(data));

        return zelfProof;
    } catch (exception) {
        console.error({
            data: exception.response?.data,
            exception,
        });

        const code = exception.code || exception.response?.data?.code;
        let error = new Error(code || exception.message);

        error.code = code;

        switch (code) {
            case "ERR_INVALID_IMAGE":
                error.status = 400;
                error.message = "Invalid ZelfProof payload";

                break;

            default:
                error.status = exception.status ?? 500;
                break;
        }

        throw error;
    }
};

const encryptQR = async (data) => {
    try {
        const result = await ZelfProofModule.encryptQRCode(_toZelfProofPayload(data));

        if (result && typeof result === "object" && result.zelfQR) {
            return result.zelfQR;
        }

        return result;
    } catch (exception) {
        console.error({ VWEx: exception });

        return exception?.message;
    }
};

const PARSE_FAILURE = /fail(?:ed)? to parse|invalid zelfproof|invalid senseprint|err_invalid_zelfproof|err_invalid_senseprint/i;

const isParseFailure = (error) => {
    const text = `${error?.code || ""} ${error?.message || ""} ${error?.error?.code || ""} ${error?.error?.message || ""}`;
    return PARSE_FAILURE.test(text);
};

const knownStack = (data = {}) => {
    if (data.stack === "v4") return "v4";
    if (data.stack === "legacy") return "legacy";
    const raw = data.v ?? data.encryptVersion ?? data.publicData?.v ?? data.publicData?.encryptVersion ?? data.publicData?.zelfEncryptVersion;
    const version = Number.parseInt(String(raw ?? ""), 10);
    if (version === 4) return "v4";
    if (version === 3) return "legacy";
    return null;
};

const withStack = (data, stack) => {
    const payload = { ...data };
    if (stack === "v4") payload.stack = "v4";
    else delete payload.stack;
    if (payload.zelfProof) payload.zelfProof = String(payload.zelfProof).replace(/ /g, "+");
    return payload;
};

/**
 * v4 proofs decrypt on the v4 stack. Older proofs stay on the legacy stack.
 * When the record does not say which, a parse failure on one stack tries the other.
 */
const callWithStackFallback = async (data, invoke) => {
    const stack = knownStack(data);
    if (stack === "v4") return invoke(withStack(data, "v4"));
    if (stack === "legacy") return invoke(withStack(data, "legacy"));

    try {
        const legacy = await invoke(withStack(data, "legacy"));
        if (legacy?.error && isParseFailure(legacy.error)) return invoke(withStack(data, "v4"));
        return legacy;
    } catch (error) {
        if (!isParseFailure(error)) throw error;
        return invoke(withStack(data, "v4"));
    }
};

const decrypt = async (data) => {
    try {
        return await callWithStackFallback(data, (attempt) => ZelfProofModule.decrypt(attempt));
    } catch (exception) {
        const code = exception.code;
        let error = new Error(code || exception.message);

        error.code = code;

        switch (code) {
            case "ERR_INVALID_IMAGE":
            case "ERR_INVALID_SENSEPRINT_BYTES":
                error.status = 400;

                error.message = "Decrypting error";

                break;
            case "ERR_PASSWORD_REQUIRED":
                error.status = 409;

                error.message = "Password required";

                break;
            default:
                error.status = exception.status || 500;
                error.message = exception.message;

                break;
        }

        throw error;
    }
};

const preview = async (data) => {
    try {
        return await callWithStackFallback(data, (attempt) => ZelfProofModule.preview(attempt));
    } catch (exception) {
        console.error({
            exception,
            _exception: exception.response?.data,
        });
        throw exception;
    }
};

module.exports = {
    encrypt,
    encryptQR,
    decrypt,
    preview,
};
