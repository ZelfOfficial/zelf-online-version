/**
 * Identity check for a $0 Zelf ID checkout (100% coupon or license whitelist).
 * The caller must prove they control the name being granted:
 * a session stamped `verifiedTagName` for that normalized name inside `verifiedUntil`,
 * or `faceBase64` (and `masterPassword` when the wallet has a password) checked against that name.
 * A failed check throws before any grant or coupon redemption.
 */
const Session = require("../../Session/models/session.model");
const { normalizeZelfName } = require("../../Tags/modules/zelf-name.util");
const { isNoPassword } = require("./zelf-id-password.module");

const IDENTITY_STATUS = {
    ERR_IDENTITY_VERIFICATION_REQUIRED: 400,
    ERR_MISSING_PASSWORD: 400,
    ERR_INVALID_PASSWORD: 401,
    ERR_PASSWORD_REQUIRED: 409,
    ERR_VERIFICATION_FAILED: 422,
    ERR_SESSION_OWNER_MISMATCH: 403,
};

const throwIdentityError = (code) => {
    const status = IDENTITY_STATUS[code] || 422;
    const error = new Error(`${status}:${code}`);
    error.clientCode = code;
    error.clientMessage = code;
    error.code = code;
    error.status = status;
    throw error;
};

const resolveMasterPassword = (data) => {
    const candidates = [data?.masterPassword, data?.password];

    for (const candidate of candidates) {
        if (typeof candidate !== "string") continue;
        if (candidate.trim() === "") continue;
        if (isNoPassword(candidate.trim())) continue;
        return candidate;
    }

    return undefined;
};

const hasPasswordFlag = (publicData) => {
    const flag = publicData?.hasPassword;
    return flag === true || String(flag).toLowerCase() === "true";
};

const proofRequiresPassword = async (tagObject) => {
    const zelfProof = tagObject?.zelfProof;

    if (typeof zelfProof === "string" && zelfProof) {
        try {
            const ZelfProofModule = require("../../ZelfProof/modules/zelf-proof.module");
            const previewResult = await ZelfProofModule.previewWithLegacyFallback({ zelfProof });
            const fromLayer = ZelfProofModule.passwordLayerRequiresPassword(previewResult?.passwordLayer);
            if (fromLayer === true || fromLayer === false) return fromLayer;
        } catch (_previewError) {
            // Preview can be down. The ownership decrypt still enforces the proof's password layer.
        }
    }

    return hasPasswordFlag(tagObject?.publicData);
};

const mapDecryptError = (error) => {
    if (error?.clientCode && IDENTITY_STATUS[error.clientCode]) throw error;

    const code = typeof error?.code === "string" ? error.code : "";
    if (IDENTITY_STATUS[code]) throwIdentityError(code);

    const normalized = String(error?.message || "").toLowerCase();

    if (normalized.includes("password") && normalized.includes("invalid")) throwIdentityError("ERR_INVALID_PASSWORD");
    if (normalized.includes("password") && normalized.includes("required")) throwIdentityError("ERR_PASSWORD_REQUIRED");
    if (
        normalized.includes("liveness") ||
        normalized.includes("face is not central") ||
        normalized.includes("no face detected") ||
        normalized.includes("multiple face") ||
        normalized.includes("face not recognized") ||
        normalized.includes("verification failed")
    ) {
        throwIdentityError("ERR_VERIFICATION_FAILED");
    }

    throw error;
};

/**
 * Current server stamp for this session, or null when there is none or the window has closed.
 * @param {Object} authUser
 * @returns {Promise<string|null>} normalized `name.domain`
 */
const currentVerifiedZelfName = async (authUser) => {
    if (!authUser?.session) return null;

    const session = await Session.findById(authUser.session).lean();
    if (!session || session.status !== "active") return null;
    if (!session.verifiedTagName || !session.verifiedUntil) return null;
    if (new Date(session.verifiedUntil).getTime() <= Date.now()) return null;

    const normalized = normalizeZelfName(session.verifiedTagName, session.domain || authUser.domain || "zelf");
    return normalized.zelfName || null;
};

/**
 * @param {Object} params
 * @param {string} params.tagName bare or full name being granted
 * @param {string} params.domain
 * @param {Object} params.tagObject
 * @param {Object} [params.authUser]
 * @param {string} [params.faceBase64]
 * @param {string} [params.masterPassword]
 * @param {string} [params.password]
 */
const assertFreeCheckoutIdentity = async ({ tagName, domain, tagObject, authUser, faceBase64, masterPassword, password }) => {
    const target = normalizeZelfName(tagName, domain);
    if (!target.zelfName) throwIdentityError("ERR_IDENTITY_VERIFICATION_REQUIRED");

    const verifiedName = await currentVerifiedZelfName(authUser);
    if (verifiedName && verifiedName === target.zelfName) return;

    const face = typeof faceBase64 === "string" ? faceBase64.trim() : "";

    if (verifiedName && verifiedName !== target.zelfName && !face) {
        throwIdentityError("ERR_SESSION_OWNER_MISMATCH");
    }

    if (!face) throwIdentityError("ERR_IDENTITY_VERIFICATION_REQUIRED");

    const secret = resolveMasterPassword({ masterPassword, password });
    const requiresPassword = await proofRequiresPassword(tagObject);

    if (requiresPassword && !secret) throwIdentityError("ERR_MISSING_PASSWORD");

    try {
        const TagsModule = require("../../Tags/modules/tags.module");
        await TagsModule.decryptTag(
            {
                tagName: target.tagName,
                domain: target.domain,
                faceBase64: face,
                password: secret,
                masterPassword: secret,
            },
            authUser || {}
        );
    } catch (error) {
        mapDecryptError(error);
    }
};

module.exports = {
    assertFreeCheckoutIdentity,
    currentVerifiedZelfName,
    IDENTITY_STATUS,
};
