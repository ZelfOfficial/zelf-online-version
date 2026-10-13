/**
 * Password / security-type normalization for Zelf ID lease, decrypt and recovery.
 *
 * Clients (extension, older mobile builds) send the literal "NO_PASSWORD_PLACEHOLDER" for face-only IDs.
 * The placeholder is accepted everywhere and treated as "no password" so existing clients keep working.
 */
const NO_PASSWORD_PLACEHOLDER = "NO_PASSWORD_PLACEHOLDER";

const SECURITY_TYPES = ["pin", "password", "securePassword", "withoutPassword"];

/** True when the value means "no password" (empty or the client placeholder). */
const isNoPassword = (password) => !password || password === NO_PASSWORD_PLACEHOLDER;

/**
 * Password to hand to ZelfProof encrypt/decrypt, or null for face-only.
 * @param {{ password?: string, securityType?: string, hasPassword?: string|boolean }} params
 * @returns {string|null}
 */
const effectivePassword = ({ password, securityType, hasPassword } = {}) => {
    if (isNoPassword(password)) return null;
    if (securityType === "withoutPassword") return null;
    if (String(hasPassword) === "false") return null;
    return password;
};

/**
 * Security type to record for a new proof. Honours an explicit client value; otherwise infers
 * (6 digits → pin, any other password → password, none/placeholder → withoutPassword).
 * @param {string|null|undefined} password raw password from the client
 * @param {string|undefined} securityType client-provided security type
 * @returns {"pin"|"password"|"securePassword"|"withoutPassword"}
 */
const resolveSecurityType = (password, securityType) => {
    if (isNoPassword(password)) return "withoutPassword";
    if (SECURITY_TYPES.includes(securityType)) return securityType;
    return /^\d{6}$/.test(password) ? "pin" : "password";
};

module.exports = { NO_PASSWORD_PLACEHOLDER, isNoPassword, effectivePassword, resolveSecurityType };
