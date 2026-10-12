/**
 * Shared ZelfEncrypt HTTP client.
 *
 * Default stack (`data.stack` omitted) posts to legacy `/zelf/*` — used by `/api/zelf-proof` and Tags.
 * Pass `{ stack: "v4" }` for HumanAuthn and ZelfID (`/zelf-v4/*`).
 */
const axiosCore = require("../../../Core/axios");
const axios = axiosCore.getEncryptionInstance();
const config = require("../../../Core/config");
const { serverError } = require("../../../Core/loggin");
const { QRZelfProofExtractor } = require("../../Tags/modules/qr-zelfproof-extractor.module");
const QRCode = require("qrcode");

let _axiosV4 = null;

/**
 * Axios instance for ZelfEncrypt v4 (`config.zelfProofV4.url`).
 * @returns {import("axios").AxiosInstance}
 */
const getV4Client = () => {
    if (!_axiosV4) _axiosV4 = axiosCore.getEncryptionInstanceV4();
    return _axiosV4;
};

/**
 * Pick the encrypt HTTP client and path prefix from `data.stack` only.
 * @param {{ stack?: string }} [data]
 * @returns {{ client: import("axios").AxiosInstance, prefix: string }}
 * `stack === "v4"` → `{ client: v4Axios, prefix: "/zelf-v4" }` (or `ZELF_PROOF_V4_PATH_PREFIX`).
 * Otherwise → `{ client: legacyAxios, prefix: "/zelf" }`.
 */
const resolveZelfEncryptStack = (data = {}) => {
    if (data.stack === "v4") {
        const prefix = String(config.zelfProofV4.pathPrefix || "/zelf-v4").replace(/\/+$/, "") || "/zelf-v4";

        return { client: getV4Client(), prefix };
    }

    return { client: axios, prefix: "/zelf" };
};

/**
 * Upstream `verifiers_auth_key` when the caller set a verifier or asked for the server password layer.
 * @param {{ verifierKey?: string, addServerPassword?: boolean }} data
 * @returns {string|undefined} `config.zelfEncrypt.serverKey` when either flag is truthy
 */
const verifierAuthKey = (data) =>
    data.verifierKey || data.addServerPassword ? config.zelfEncrypt.serverKey : undefined;

/**
 * Shared encrypt body. v4 uses different liveness field names than 3.1.6:
 * - 3.1.6 `liveness_detection_prior_creation: false` means "server, check this still image now"
 * - v4 `check_live_face_before_creation: true` means the same check (names are inverted)
 * Sending the 3.1.6 field (default false) at v4 makes still-photo encrypt fail with LIVENESS CHECK FAILED.
 *
 * `require_live_face` is a decrypt-time flag on the proof, not the creation check.
 * Use `??` so `requireLiveness: false` is honored (`false || true` is always true).
 *
 * @param {Object} data
 * @param {"v4"|undefined} stack
 * @returns {Object}
 */
const encryptUpstreamBody = (data, stack) => {
    const body = {
        cleartext_data: data.publicData,
        face_base_64: normalizeFaceBase64(data.faceBase64),
        metadata: data.metadata,
        password: data.password || undefined,
        record_id: data.identifier || data.record_id || data._id,
        require_live_face: data.requireLiveness ?? true,
        tolerance: data.tolerance || "REGULAR",
        verifiers_auth_key: verifierAuthKey(data),
        os: data.os || "DESKTOP",
    };

    if (stack === "v4") {
        body.check_live_face_before_creation = data.check_live_face_before_creation === true;
        body.liveness_tolerance = data.liveness_tolerance || data.livenessLevel || "REGULAR";
        if (data.referenceFaceBase64) {
            body.ref_face_base_64 = normalizeFaceBase64(data.referenceFaceBase64);
        }
        return body;
    }

    body.liveness_detection_prior_creation = data.livenessDetectionPriorCreation || false;
    return body;
};

/**
 * Upstream `/zelf/*` expects raw base64 image bytes. Clients often send a data URL
 * (`data:image/jpeg;base64,...`) from `readAsDataURL` or paste — strip prefix and whitespace.
 * @param {string} [faceBase64]
 * @returns {string|undefined}
 */
const normalizeFaceBase64 = (faceBase64) => {
    if (faceBase64 == null || typeof faceBase64 !== "string") return faceBase64;
    const trimmed = faceBase64.trim();
    const marker = "base64,";
    const idx = trimmed.indexOf(marker);
    if (idx !== -1 && trimmed.slice(0, 5).toLowerCase() === "data:") {
        return trimmed.slice(idx + marker.length).replace(/\s/g, "");
    }
    return trimmed.replace(/\s/g, "");
};

/**
 * Encrypt a face-bound proof.
 * POST `${prefix}/encrypt`.
 *
 * @param {Object} data
 * @param {"v4"|undefined} [data.stack] omit for legacy `/zelf`; `"v4"` for `/zelf-v4`
 * @param {Object<string, string>} [data.publicData] cleartext key/values stored on the proof
 * @param {string} data.faceBase64 face image (raw base64 or `data:image/...;base64,...`)
 * @param {Object<string, string>} [data.metadata] private payload (e.g. mnemonic)
 * @param {string} [data.password]
 * @param {string} [data.identifier] record id (also `record_id` or `_id`)
 * @param {string} [data.record_id]
 * @param {string} [data._id]
 * @param {boolean} [data.livenessDetectionPriorCreation=false]
 * @param {boolean} [data.requireLiveness=true]
 * @param {string} [data.tolerance="REGULAR"]
 * @param {string} [data.verifierKey]
 * @param {boolean} [data.addServerPassword]
 * @returns {Promise<{ zelfProof: string }>}
 * @throws {Error} upstream encrypt failure (`error.code`, `error.status` when known)
 */
const encrypt = async (data) => {
    try {
        const { client, prefix } = resolveZelfEncryptStack(data);
        const encryptedResponse = await client.post(
            `${prefix}/encrypt`,
            encryptUpstreamBody(data, data.stack)
        );

        const zelfProof = encryptedResponse.data.zelfProof;

        return { zelfProof };
    } catch (exception) {
        const error = _formattingError(exception.response?.data);
        const wrapped = new Error(error.message || "Something went wrong");

        wrapped.code = error.code;
        wrapped.status = error.status;

        throw wrapped;
    }
};

/**
 * Build a local PNG data-URL QR from an existing proof string (not an upstream call; not exported).
 * @param {{ zelfProof: string }} data
 * @returns {Promise<{ zelfProof: string, QRCode: string }|null>}
 */
const generateQRCode = async (data) => {
    try {
        const base64Data = Buffer.from(data.zelfProof, "binary").toString("base64");

        // Generate the QR code with the base64 string
        const qrCode = await QRCode.toDataURL(base64Data, {
            errorCorrectionLevel: "H", // High error correction
        });

        return { zelfProof: base64Data, QRCode: qrCode };
    } catch (error) {
        console.error("Error generating QR code:", error);
        return null;
    }
};

/**
 * Encrypt and return a PNG QR of the proof.
 * POST `${prefix}/encrypt-qr-code`.
 *
 * @param {Object} data same inbound as {@link encrypt}, plus:
 * @param {"v4"|undefined} [data.stack]
 * @param {string} [data.os="DESKTOP"] `DESKTOP` | `ANDROID` | `IOS`
 * @param {boolean} [data.generateZelfProof] if true, extract raw proof bytes from the QR
 * @param {boolean} [data.check_live_face_before_creation=false]
 * @returns {Promise<{ zelfQR: string, zelfProof?: string }|string>} QR data URL; proof only when `generateZelfProof`. Error path may return a string message.
 */
const encryptQRCode = async (data) => {
    try {
        const { client, prefix } = resolveZelfEncryptStack(data);
        const encryptedResponse = await client.post(
            `${prefix}/encrypt-qr-code`,
            {
                ...encryptUpstreamBody(data, data.stack),
                qr_format: "PNG",
            },
            { responseType: "arraybuffer" }
        );

        if (!encryptedResponse?.data) return encryptedResponse;

        const base64Image = Buffer.from(encryptedResponse.data).toString("base64");
        const zelfQR = `data:image/png;base64,${base64Image}`;

        let zelfProof = null;

        if (data.generateZelfProof) {
            zelfProof = await QRZelfProofExtractor.extractZelfProof(base64Image);
        }

        return { zelfQR, zelfProof: zelfProof || undefined };
    } catch (exception) {
        return exception?.message;
    }
};

/**
 * Decrypt a proof with a live face (and password when the proof has a password layer).
 * POST `${prefix}/decrypt`. Upstream body field is `senseprint_base_64` (wire name; Koa inbound is `zelfProof`).
 *
 * @param {Object} data
 * @param {"v4"|undefined} [data.stack]
 * @param {string} data.zelfProof required proof bytes (base64)
 * @param {string} data.faceBase64
 * @param {string} [data.os="DESKTOP"]
 * @param {string} [data.password]
 * @param {string|boolean} [data.hasPassword] informational only; a provided password is always forwarded
 * @param {string} [data.verifierKey]
 * @param {boolean} [data.addServerPassword]
 * @returns {Promise<Object>} upstream decrypt payload (`publicData`, `metadata`, …)
 * @throws {Error} `400:missing_zelf_proof` or mapped upstream error (`status`, `code`)
 */
const decrypt = async (data) => {
    if (!data.zelfProof) throw new Error("400:missing_zelf_proof");

    try {
        const { client, prefix } = resolveZelfEncryptStack(data);

        const encryptedResponse = await client.post(`${prefix}/decrypt`, {
            face_base_64: normalizeFaceBase64(data.faceBase64),
            os: data.os || "DESKTOP",
            password: data.password || undefined,
            senseprint_base_64: data.zelfProof,
            verifiers_auth_key: verifierAuthKey(data),
        });

        return encryptedResponse?.data;
    } catch (exception) {
        const error = _formattingError(exception.response?.data);

        let _error = new Error(error.message);

        _error.status = error.status;
        _error.code = error.code;

        throw _error;
    }
};

const passwordLayerRequiresPassword = (layer) => {
    if (layer === "WithPassword" || layer === "Password") return true;
    if (layer === "WithoutPassword" || layer === "NoPassword") return false;

    return undefined;
};

const hasPasswordFromPasswordLayer = (layer) => {
    const required = passwordLayerRequiresPassword(layer);

    if (required === true) return "true";
    if (required === false) return "false";

    return "";
};

const shouldBackfillHasPassword = (publicData, encryptVersion) => {
    if (!publicData) return false;
    if (!publicData.hasPassword) return true;

    return Number(encryptVersion) !== 4 && String(publicData.hasPassword) === "false";
};

const applyPreviewHasPassword = (tagObject, preview) => {
    if (!tagObject?.publicData || !preview) return tagObject;

    const flag = hasPasswordFromPasswordLayer(preview.passwordLayer);

    if (flag) tagObject.publicData.hasPassword = flag;
    if (preview.publicData?.st && !tagObject.publicData.st) {
        tagObject.publicData.st = preview.publicData.st;
    }

    return tagObject;
};

const previewWithLegacyFallback = async (data = {}) => {
    const { stack: _stack, ...rest } = data;
    let v4Preview = null;

    try {
        v4Preview = await preview({ ...rest, stack: "v4" });
        if (v4Preview?.passwordLayer) return v4Preview;
    } catch (_error) {
        v4Preview = null;
    }

    try {
        const legacyPreview = await preview(rest);

        if (legacyPreview) return legacyPreview;
    } catch (error) {
        if (v4Preview) return v4Preview;
        throw error;
    }

    return v4Preview;
};

/**
 * Preview public fields of a proof without a face (no decrypt).
 * POST `${prefix}/preview`. Upstream body field is `senseprint_base_64`.
 *
 * @param {Object} data
 * @param {"v4"|undefined} [data.stack]
 * @param {string} data.zelfProof required
 * @param {string} [data.verifierKey]
 * @param {boolean} [data.addServerPassword]
 * @returns {Promise<Object>} upstream preview (`publicData`, `passwordLayer`, …)
 * @throws {Error} `400:missing_zelf_proof` or mapped upstream error
 */
const preview = async (data) => {
    if (!data.zelfProof || typeof data.zelfProof !== "string") throw new Error("400:missing_zelf_proof");

    try {
        const { client, prefix } = resolveZelfEncryptStack(data);
        const encryptedResponse = await client.post(`${prefix}/preview`, {
            senseprint_base_64: data.zelfProof,
            verifiers_auth_key: data.verifierKey || (data.addServerPassword ? config.zelfEncrypt.serverKey : undefined),
        });

        return encryptedResponse?.data;
    } catch (exception) {
        const error = _formattingError(exception.response?.data);

        let _error = new Error(error.message);

        _error.status = error.status;
        _error.code = error.code;

        throw _error;
    }
};

const _summarizeBase64 = (value) => {
    if (value == null) return { present: false, length: 0, prefix: null };
    const text = String(value);
    return {
        present: true,
        length: text.length,
        prefix: text.slice(0, 16),
    };
};

const _logUpgradeFailure = (exception, body) => {
    const response = exception?.response;
    const upstream = response?.data;

    serverError("ZelfEncrypt upgrade failed", {
        axiosCode: exception?.code || null,
        httpStatus: response?.status || null,
        requestUrl: response?.config?.url || exception?.config?.url || null,
        requestMethod: response?.config?.method || exception?.config?.method || "post",
        upstreamCode: upstream?.code || null,
        upstreamMessage: upstream?.message || upstream?.error || exception?.message || null,
        upstreamBody: upstream && typeof upstream === "object" ? upstream : typeof upstream,
        hasPassword: Boolean(body?.password),
        hasVerifierKey: Boolean(body?.verifiers_auth_key),
        requireLiveFace: body?.require_live_face,
        face: _summarizeBase64(body?.face_base_64),
        prevSenseprint: _summarizeBase64(body?.prev_senseprint_base_64),
    });
};

/**
 * True when v4 nginx has not mapped this path to SenseCrypt yet (falls through
 * to Koa JWT 401, or a real 404).
 * @param {import("axios").AxiosError} [error]
 * @returns {boolean}
 */
const _isMissingUpgradeRoute = (error) => {
    const status = error?.response?.status;
    const body = error?.response?.data || {};
    const text = String(body.error || body.message || "");

    if (status === 404) return true;
    if (status === 401 && text.toLowerCase().includes("protected resource")) return true;

    return false;
};

/**
 * Re-issue an existing SensePrint as a freshly-keyed V4 proof (SenseCrypt
 * `/refresh-senseprint-face`). Always uses the v4 stack. Nginx on v4.zelf.world
 * maps `${prefix}/upgrade` to that native path.
 *
 * @param {Object} data
 * @param {string} data.zelfProof previous proof bytes (any V1–V4)
 * @param {string} data.faceBase64 face that must match the previous proof
 * @param {string} [data.password]
 * @param {boolean} [data.requireLiveness=true] liveness flag stored on the new proof
 * @param {string} [data.verifierKey]
 * @param {boolean} [data.addServerPassword]
 * @returns {Promise<{ zelfProof: string }>}
 * @throws {Error} `400:missing_zelf_proof` or mapped upstream error
 */
const upgrade = async (data) => {
    if (!data.zelfProof) throw new Error("400:missing_zelf_proof");

    const body = {
        face_base_64: normalizeFaceBase64(data.faceBase64),
        prev_senseprint_base_64: data.zelfProof,
        password: data.password || undefined,
        require_live_face: data.requireLiveness ?? true,
        verifiers_auth_key: verifierAuthKey(data),
    };

    try {
        const { client, prefix } = resolveZelfEncryptStack({ stack: "v4" });

        // Prefer the public nginx alias. Fall back to SenseCrypt's native path
        // until `location /zelf-v4/upgrade` is live on v4.zelf.world.
        let upgradedResponse;
        try {
            upgradedResponse = await client.post(`${prefix}/upgrade`, body);
        } catch (upgradeError) {
            if (!_isMissingUpgradeRoute(upgradeError)) throw upgradeError;

            try {
                upgradedResponse = await client.post(`${prefix}/refresh-senseprint-face`, body);
            } catch (prefixedError) {
                if (!_isMissingUpgradeRoute(prefixedError)) throw prefixedError;
                upgradedResponse = await client.post("/refresh-senseprint-face", body);
            }
        }

        const zelfProof = upgradedResponse?.data?.senseprint_base_64 || upgradedResponse?.data?.zelfProof;

        if (!zelfProof) throw new Error("400:missing_zelf_proof");

        return { zelfProof };
    } catch (exception) {
        if (exception.message === "400:missing_zelf_proof") throw exception;

        _logUpgradeFailure(exception, body);

        const error = _formattingError(exception.response?.data || {});
        if (_isMissingUpgradeRoute(exception) || !error.message) {
            error.message = error.message || "UPGRADE_PATH_NOT_FOUND";
            error.status = 404;
        }

        const wrapped = new Error(error.message || "Something went wrong");

        wrapped.code = error.code;
        wrapped.status = error.status || exception.response?.status || 500;

        throw wrapped;
    }
};

/** ZelfProof error codes caused by user input (wrong password, wrong face, bad proof bytes). */
const ZELFPROOF_CLIENT_ERROR_STATUS = {
    ERR_INVALID_PASSWORD: 401,
    ERR_PASSWORD_REQUIRED: 409,
    ERR_VERIFICATION_FAILED: 409,
    ERR_INVALID_ZELFPROOF_BYTES: 400,
    ERR_INVALID_ZELFPROOF: 400,
};

/**
 * Normalize upstream error `code`/`message` and assign HTTP `status` (422 face, 401 auth, 400 image, 409 password, else 500).
 * @param {Object} [error]
 * @returns {Object} same object with `status` set when missing
 */
const _formattingError = (error = {}) => {
    if (error?.code?.includes(config.terms.zk)) {
        error.code = error.code.replaceAll(config.terms.zk, config.terms._zk).toUpperCase();
    }

    error.message = error.message?.toUpperCase();

    if (error.message?.includes(config.terms.zk)) {
        error.message = error.message.replaceAll(config.terms.zk, config.terms._zk).toUpperCase();
    }

    // Known ZelfProof client errors map to 4xx even when upstream reported 500.
    const clientStatus = ZELFPROOF_CLIENT_ERROR_STATUS[error.code];

    if (clientStatus && (!error.status || error.status >= 500)) {
        error.status = clientStatus;
    }

    // Determine appropriate HTTP status code based on error type
    if (!error.status) {
        const message = error.message || "";
        const code = error.code || "";

        // Face validation errors - 422 Unprocessable Entity
        if (
            message.includes("FACE IS NOT CENTRAL") ||
            message.includes("NOT CENTRAL") ||
            message.includes("MULTIPLE FACE") ||
            message.includes("NO FACE DETECTED") ||
            message.includes("FACE NOT RECOGNIZED") ||
            message.includes("LIVENESS") ||
            message.includes("FACE QUALITY") ||
            message.includes("FACE TOO SMALL") ||
            message.includes("FACE TOO LARGE") ||
            code.includes("FACE_")
        ) {
            error.status = 422;
        }
        // Authentication/verification errors - 401 Unauthorized
        else if (
            message.includes("INVALID PASSWORD") ||
            message.includes("AUTHENTICATION FAILED") ||
            message.includes("UNAUTHORIZED") ||
            code.includes("AUTH_")
        ) {
            error.status = 401;
        }
        // Invalid image or data format - 400 Bad Request
        else if (
            message.includes("INVALID IMAGE") ||
            message.includes("INVALID FORMAT") ||
            message.includes("INVALID DATA") ||
            code === "ERR_INVALID_IMAGE" ||
            code === "ERR_INVALID_SENSEPRINT_BYTES"
        ) {
            error.status = 400;
        } else if (code === "ERR_PASSWORD_REQUIRED") {
            error.status = 409;
        }
        // Default to 500 for unknown errors
        else {
            error.status = 500;
        }
    }

    return error;
};

module.exports = {
    _formattingError,
    ZELFPROOF_CLIENT_ERROR_STATUS,
    encrypt,
    encryptQRCode,
    decrypt,
    preview,
    previewWithLegacyFallback,
    passwordLayerRequiresPassword,
    hasPasswordFromPasswordLayer,
    shouldBackfillHasPassword,
    applyPreviewHasPassword,
    upgrade,
};
