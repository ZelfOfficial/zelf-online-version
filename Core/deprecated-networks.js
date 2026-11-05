/**
 * Chains, Zelf ID domains, and payment networks that no longer accept new use.
 * Lookups of names that already exist stay available. This list is the gate;
 * the Mongo `domains` record is not modified here.
 *
 * HTTP 410 Gone: support ended with no grace period, so the condition is permanent.
 * 409 is already the generic validation conflict in this API. A distinct status
 * lets older apps branch without parsing every conflict body.
 */

const { errorHandler } = require("./http-handler");

const STATUS = 410;
const CODE = "BDAG_DEPRECATED";
const MESSAGE =
    "BlockDAG (BDAG) is no longer supported. Export your 12 or 24 recovery words and import them into another wallet.";

/** Registry domains that must not be registered, leased, purchased, or renewed. */
const DEPRECATED_DOMAINS = Object.freeze(["bdag"]);

/** Chain ids and aliases that must not be activated. */
const DEPRECATED_CHAINS = Object.freeze(["blockdag", "bdag"]);

/** Checkout networks that must not be quoted or confirmed. Includes ZelfBlockDagPay. */
const DEPRECATED_PAYMENT_NETWORKS = Object.freeze(["BDAG", "BLOCKDAG", "BLOCKDAG_SC"]);

const domainSet = new Set(DEPRECATED_DOMAINS);
const chainSet = new Set(DEPRECATED_CHAINS);
const paymentSet = new Set(DEPRECATED_PAYMENT_NETWORKS);

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

const normalizePaymentNetwork = (value) =>
    String(value || "")
        .trim()
        .toUpperCase()
        .replace(/[\s-]+/g, "_");

const isDeprecatedDomain = (value) => {
    const key = domainFromIdentifier(value);
    return Boolean(key) && domainSet.has(key);
};

const isDeprecatedChain = (value) => {
    const key = normalizeChain(value);
    return Boolean(key) && chainSet.has(key);
};

const isDeprecatedPaymentNetwork = (value) => {
    const key = normalizePaymentNetwork(value);
    return Boolean(key) && paymentSet.has(key);
};

/**
 * @param {{ domain?: string, chain?: string, network?: string, campaign?: string }} [details]
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

const assertDomainAcceptsNewUse = (domain) => {
    if (!isDeprecatedDomain(domain)) return;
    throw deprecatedUseError({ domain: domainFromIdentifier(domain) });
};

const assertChainAcceptsNewUse = (chain) => {
    if (!isDeprecatedChain(chain)) return;
    throw deprecatedUseError({ chain: normalizeChain(chain) });
};

const assertPaymentNetworkAccepted = (network) => {
    if (!isDeprecatedPaymentNetwork(network)) return;
    throw deprecatedUseError({ network: normalizePaymentNetwork(network) });
};

/**
 * Writes the client contract and returns true when the request is closed.
 * Payment networks are checked before Joi so `BDAG` is not a generic enum failure.
 * @param {Object} ctx
 * @param {{ domain?: string, tagName?: string, network?: string }} [source]
 * @returns {boolean}
 */
const rejectDeprecatedRequest = (ctx, { domain, tagName, network } = {}) => {
    const domainKey = normalizeDomain(domain) || domainFromIdentifier(tagName);
    if (isDeprecatedDomain(domainKey)) {
        const handled = errorHandler(deprecatedUseError({ domain: domainFromIdentifier(domainKey) }), ctx);
        ctx.status = handled.status;
        ctx.body = { code: handled.code, message: handled.message };
        return true;
    }

    if (isDeprecatedPaymentNetwork(network)) {
        const handled = errorHandler(deprecatedUseError({ network: normalizePaymentNetwork(network) }), ctx);
        ctx.status = handled.status;
        ctx.body = { code: handled.code, message: handled.message };
        return true;
    }

    return false;
};

module.exports = {
    CODE,
    DEPRECATED_CHAINS,
    DEPRECATED_DOMAINS,
    DEPRECATED_PAYMENT_NETWORKS,
    MESSAGE,
    STATUS,
    assertChainAcceptsNewUse,
    assertDomainAcceptsNewUse,
    assertPaymentNetworkAccepted,
    deprecatedUseError,
    domainFromIdentifier,
    isDeprecatedChain,
    isDeprecatedDomain,
    isDeprecatedPaymentNetwork,
    rejectDeprecatedRequest,
};
