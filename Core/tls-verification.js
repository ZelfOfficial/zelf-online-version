/**
 * Startup notice when production is running with TLS certificate checks disabled.
 * Node turns verification off for every outbound TLS connection when
 * NODE_TLS_REJECT_UNAUTHORIZED is exactly "0". This does not exit the process.
 */

const TLS_VERIFICATION_DISABLED_WARNING =
    "NODE_TLS_REJECT_UNAUTHORIZED=0 is set while NODE_ENV is production. TLS certificate verification is disabled for every outbound connection from this process. Remove that variable from the server environment and restart. Startup continues.";

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ warn?: (message: string) => void }} [logger]
 * @returns {boolean} true when a warning was written
 */
const warnIfTlsVerificationDisabled = (env = process.env, logger = console) => {
    const nodeEnv = env.NODE_ENV || "development";
    if (nodeEnv !== "production" || env.NODE_TLS_REJECT_UNAUTHORIZED !== "0") return false;

    const warn = logger && typeof logger.warn === "function" ? logger.warn.bind(logger) : console.warn;
    warn(TLS_VERIFICATION_DISABLED_WARNING);
    return true;
};

module.exports = {
    TLS_VERIFICATION_DISABLED_WARNING,
    warnIfTlsVerificationDisabled,
};
