/**
 * Password / security-type normalization for Zelf ID lease, decrypt and recovery.
 *
 * Clients (extension, older mobile builds) send the literal "NO_PASSWORD_PLACEHOLDER" for face-only IDs.
 * The placeholder is accepted everywhere and treated as "no password" so existing clients keep working.
 */
const NO_PASSWORD_PLACEHOLDER = "NO_PASSWORD_PLACEHOLDER";


/** True when the value means "no password" (empty or the client placeholder). */
const isNoPassword = (password) => !password || password === NO_PASSWORD_PLACEHOLDER;

/**
 * Password to hand to ZelfProof encrypt/decrypt, or null for face-only.
 * @param {{ password?: string, hasPassword?: string|boolean }} params
 * @returns {string|null}
 */
// securityType is accepted from clients for compatibility but never changes how a password is used.
const effectivePassword = ({ password, hasPassword } = {}) => {
    if (isNoPassword(password)) return null;
    if (String(hasPassword) === "false") return null;
    return password;
};

/**
 * Security type to record for a proof, always derived from the decrypted (plaintext) password:
 * none/placeholder -> withoutPassword, 6 digits -> pin, anything else -> password.
 * Any client-sent securityType (including the retired "securePassword" from extension 2.1.43) is ignored.
 * @param {string|null|undefined} password plaintext password (after PGP decryption)
 * @returns {"pin"|"password"|"withoutPassword"}
 */
const resolveSecurityType = (password) => {
    if (isNoPassword(password)) return "withoutPassword";
    return /^\d{6}$/.test(password) ? "pin" : "password";
};

const isPasswordRequiredError = (error) => {
    const code = error?.code || "";
    const message = String(error?.message || "").toUpperCase();
    return code === "ERR_PASSWORD_REQUIRED" || message.includes("PASSWORD IS REQUIRED") || message.includes("PASSWORD_REQUIRED");
};

/**
 * Decrypt with the password the proof's publicData implies, retrying with the client's real password when the proof
 * says one is required. publicData.hasPassword can be stale ("false" on proofs that do need a password, e.g. qa.zelf),
 * so it may only pick the first attempt, never drop a password the proof needs.
 * @param {(args: Object) => Promise<Object>} decryptFn
 * @param {Object} args decrypt arguments without password
 * @param {{ password?: string, hasPassword?: string|boolean }} passwordInput
 * @returns {Promise<{ result: Object, password: string|null }>}
 */
const decryptWithPasswordFallback = async (decryptFn, args, { password, hasPassword } = {}) => {
    const first = effectivePassword({ password, hasPassword });
    const real = effectivePassword({ password });
    const canRetry = !first && Boolean(real);

    let result;
    try {
        result = await decryptFn({ ...args, password: first });
    } catch (error) {
        if (canRetry && isPasswordRequiredError(error)) return { result: await decryptFn({ ...args, password: real }), password: real };
        throw error;
    }
    if (canRetry && result?.error && isPasswordRequiredError(result.error)) {
        return { result: await decryptFn({ ...args, password: real }), password: real };
    }
    return { result, password: first };
};

/**
 * When decrypt succeeds with a real password on a record whose stored publicData.hasPassword
 * was stale ("false" or missing, e.g. qa.zelf), heal publicData.hasPassword to "true" (and st
 * if missing) and return true so the caller can also include hasPassword in tagsToAdd for re-pin.
 * @param {Object} tagObject
 * @param {string|null|undefined} password effective password returned by decryptWithPasswordFallback
 * @returns {boolean} true when publicData.hasPassword was healed to "true"
 */
const healDecryptedTagPassword = (tagObject, password) => {
    if (!tagObject?.publicData || isNoPassword(password)) return false;

    const wasStale = String(tagObject.publicData.hasPassword) !== "true";
    tagObject.publicData.hasPassword = "true";

    if (!tagObject.publicData.st) {
        tagObject.publicData.st = resolveSecurityType(password);
    }

    return wasStale;
};

module.exports = {
    NO_PASSWORD_PLACEHOLDER,
    isNoPassword,
    effectivePassword,
    resolveSecurityType,
    isPasswordRequiredError,
    decryptWithPasswordFallback,
    healDecryptedTagPassword,
};
