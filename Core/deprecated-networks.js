/**
 * BlockDAG names and chain activation that no longer accept new use.
 * An existing name still resolves, renews, and pays. A chain the Zelf ID
 * already has stays activatable. The Mongo `domains` record is not modified here.
 *
 * HTTP 410 Gone: the closed action is permanent. 409 is this API's generic
 * validation conflict, so older apps can branch on 410 without reading every 409.
 */

const STATUS = 410;
const CODE = "BDAG_DEPRECATED";
const MESSAGE =
    "BlockDAG (BDAG) is no longer supported. Export your 12 or 24 recovery words and import them into another wallet.";

/** Registry domains that must not receive a new name. */
const DEPRECATED_DOMAINS = Object.freeze(["bdag"]);

/** Chain ids and aliases that must not be activated for the first time. */
const DEPRECATED_CHAINS = Object.freeze(["blockdag", "bdag"]);

const domainSet = new Set(DEPRECATED_DOMAINS);
const chainSet = new Set(DEPRECATED_CHAINS);

const normalizeDomain = (value) =>
    String(value || "")
        .trim()
        .toLowerCase()
        .replace(/^\./, "");

/**
 * `bdag`, `alice.bdag`, and `alice.bdag.hold` all name the bdag registry.
 * A bare label is returned unchanged.
 * @param {string} [value]
 * @returns {string}
 */
const domainFromIdentifier = (value) => {
    const raw = normalizeDomain(value);
    if (!raw) return "";
    const parts = raw.split(".").filter(Boolean);
    if (parts.length >= 3 && parts[parts.length - 1] === "hold") return parts[parts.length - 2];
    return parts[parts.length - 1];
};

const normalizeChain = (value) =>
    String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, "-");

const isDeprecatedDomain = (value) => {
    const key = domainFromIdentifier(value);
    return Boolean(key) && domainSet.has(key);
};

const isDeprecatedChain = (value) => {
    const key = normalizeChain(value);
    return Boolean(key) && chainSet.has(key);
};

/**
 * @param {{ domain?: string, chain?: string }} [details]
 */
const deprecatedUseError = (details = {}) => {
    const error = new Error(`${STATUS}:${CODE}`);
    error.clientCode = CODE;
    error.clientMessage = MESSAGE;
    error.status = STATUS;
    error.code = CODE;
    error.details = details;
    return error;
};

/** Refuse a brand-new name on a closed domain. Call only after the name is known to be unregistered. */
const assertDomainAcceptsNewUse = (domain) => {
    if (!isDeprecatedDomain(domain)) return;
    throw deprecatedUseError({ domain: domainFromIdentifier(domain) });
};

module.exports = {
    CODE,
    DEPRECATED_CHAINS,
    DEPRECATED_DOMAINS,
    MESSAGE,
    STATUS,
    assertDomainAcceptsNewUse,
    deprecatedUseError,
    domainFromIdentifier,
    isDeprecatedChain,
    isDeprecatedDomain,
    normalizeChain,
};
