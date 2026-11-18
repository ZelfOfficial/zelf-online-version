const { codedError } = require("../../../Core/http-handler");

const PAYOUT_ADDRESS_BLOCKED = "PAYOUT_ADDRESS_BLOCKED";
const PAYOUT_ADDRESS_BLOCKED_MESSAGE = `403:${PAYOUT_ADDRESS_BLOCKED}`;

/**
 * Comma-separated wallet addresses from ZNS_PAYOUT_DENYLIST.
 * Entries are trimmed. Empty segments are dropped. Comparison stays case-sensitive.
 * @param {string|undefined|null} raw
 * @returns {string[]}
 */
const parsePayoutDenylist = (raw) =>
    String(raw ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
const payoutDenylist = (env = process.env) => parsePayoutDenylist(env.ZNS_PAYOUT_DENYLIST);

/**
 * Exact match after trim. Solana addresses are case-sensitive, so this does not lowercase.
 * An empty denylist blocks nothing.
 * @param {unknown} address
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
const isPayoutAddressBlocked = (address, env = process.env) => {
    const list = payoutDenylist(env);

    if (!list.length || address == null) return false;

    const candidate = String(address).trim();

    if (!candidate) return false;

    return list.includes(candidate);
};

/**
 * @param {unknown} error
 * @returns {boolean}
 */
const isPayoutAddressBlockedError = (error) => {
    if (!error) return false;

    if (error.code === PAYOUT_ADDRESS_BLOCKED || error.clientCode === PAYOUT_ADDRESS_BLOCKED) return true;

    return typeof error.message === "string" && error.message.trim() === PAYOUT_ADDRESS_BLOCKED_MESSAGE;
};

/**
 * Throws 403:PAYOUT_ADDRESS_BLOCKED when the address is on the denylist.
 * No-op when the denylist is empty or the address is not listed.
 * @param {unknown} address
 * @param {NodeJS.ProcessEnv} [env]
 */
const assertPayoutAddressAllowed = (address, env = process.env) => {
    if (!isPayoutAddressBlocked(address, env)) return;

    const error = codedError(PAYOUT_ADDRESS_BLOCKED_MESSAGE);

    error.status = 403;
    error.code = PAYOUT_ADDRESS_BLOCKED;

    throw error;
};

module.exports = {
    PAYOUT_ADDRESS_BLOCKED,
    PAYOUT_ADDRESS_BLOCKED_MESSAGE,
    parsePayoutDenylist,
    payoutDenylist,
    isPayoutAddressBlocked,
    isPayoutAddressBlockedError,
    assertPayoutAddressAllowed,
};
