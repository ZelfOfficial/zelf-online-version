/**
 * Chains and registry domains this API no longer serves.
 * Lists omit them. A request that names one returns 400
 * UNSUPPORTED_CHAIN or UNSUPPORTED_DOMAIN.
 * Stored license and name records are not modified here.
 */

const STATUS = 400;
const CHAIN_CODE = "UNSUPPORTED_CHAIN";
const DOMAIN_CODE = "UNSUPPORTED_DOMAIN";

const UNSUPPORTED_DOMAINS = Object.freeze(["bdag"]);
const UNSUPPORTED_CHAINS = Object.freeze(["blockdag", "bdag", "blockdag-sc"]);
const UNSUPPORTED_CHAIN_IDS = Object.freeze([1404]);

const domainSet = new Set(UNSUPPORTED_DOMAINS);
const chainSet = new Set(UNSUPPORTED_CHAINS);
const chainIdSet = new Set(UNSUPPORTED_CHAIN_IDS);

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

const isUnsupportedDomain = (value) => {
    const key = domainFromIdentifier(value);
    if (!key) return false;
    if (domainSet.has(key)) return true;
    if (key.endsWith("pay") && domainSet.has(key.slice(0, -3))) return true;
    return false;
};

const isUnsupportedChain = (value) => {
    if (typeof value === "number" && chainIdSet.has(value)) return true;
    const key = normalizeChain(value);
    if (!key) return false;
    if (/^\d+$/.test(key) && chainIdSet.has(Number(key))) return true;
    return chainSet.has(key);
};

/** Native payment symbols and smart-contract network names for a removed chain. */
const isUnsupportedPaymentMethod = (value) => isUnsupportedChain(value);

const coded = (status, code) => {
    const error = new Error(`${status}:${code}`);
    error.clientCode = code;
    error.clientMessage = code;
    error.status = status;
    error.code = code;
    return error;
};

const unsupportedDomainError = () => coded(STATUS, DOMAIN_CODE);
const unsupportedChainError = () => coded(STATUS, CHAIN_CODE);

const assertSupportedDomain = (domain) => {
    if (isUnsupportedDomain(domain)) throw unsupportedDomainError();
};

const assertSupportedChain = (chain) => {
    if (isUnsupportedChain(chain)) throw unsupportedChainError();
};

const writeUnsupported = (ctx, error) => {
    ctx.status = error.status;
    ctx.body = { code: error.code, message: error.clientMessage };
    return true;
};

const rejectIfUnsupportedDomain = (ctx, value) => {
    if (!isUnsupportedDomain(value)) return false;
    return writeUnsupported(ctx, unsupportedDomainError());
};

const rejectIfUnsupportedChain = (ctx, value) => {
    if (!isUnsupportedChain(value)) return false;
    return writeUnsupported(ctx, unsupportedChainError());
};

/**
 * Turn a domain-validation result into the HTTP response.
 * A removed domain is 400. Every other invalid domain stays 409.
 * @returns {boolean} true when the response was written
 */
const respondDomainValidation = (ctx, domainValidation) => {
    if (!domainValidation || domainValidation.valid) return false;
    if (domainValidation.code) {
        ctx.status = domainValidation.status || STATUS;
        ctx.body = { code: domainValidation.code, message: domainValidation.code };
        return true;
    }
    ctx.status = 409;
    ctx.body = { validationError: domainValidation.error };
    return true;
};

const omitUnsupportedCurrencies = (currencies) => {
    if (!Array.isArray(currencies)) return currencies;
    return currencies.filter((code) => !isUnsupportedPaymentMethod(code));
};

const omitUnsupportedNetworks = (networks) => {
    if (!networks || typeof networks !== "object" || Array.isArray(networks)) return networks;
    const next = {};
    for (const [key, value] of Object.entries(networks)) {
        if (isUnsupportedChain(key)) continue;
        const code = value?.nativeCurrency?.code;
        if (code && isUnsupportedPaymentMethod(code)) continue;
        next[key] = value;
    }
    return next;
};

/**
 * Public domain payload with removed payment networks left out.
 * Does not mutate the license object held in cache.
 * @param {Object} config
 * @returns {Object}
 */
const presentDomainRecord = (config) => {
    if (!config || typeof config !== "object") return config;
    const next = { ...config };
    if (next.tags && typeof next.tags === "object") {
        next.tags = { ...next.tags };
        if (next.tags.payment && typeof next.tags.payment === "object") {
            next.tags.payment = {
                ...next.tags.payment,
                currencies: omitUnsupportedCurrencies(next.tags.payment.currencies),
                networks: omitUnsupportedNetworks(next.tags.payment.networks),
            };
        }
        if (next.tags.wallet && typeof next.tags.wallet === "object") {
            next.tags.wallet = {
                ...next.tags.wallet,
                networks: omitUnsupportedNetworks(next.tags.wallet.networks),
            };
        }
    }
    if (next.payment && typeof next.payment === "object") {
        next.payment = {
            ...next.payment,
            currencies: omitUnsupportedCurrencies(next.payment.currencies),
            networks: omitUnsupportedNetworks(next.payment.networks),
        };
    }
    if (next.wallet && typeof next.wallet === "object") {
        next.wallet = {
            ...next.wallet,
            networks: omitUnsupportedNetworks(next.wallet.networks),
        };
    }
    return next;
};

module.exports = {
    CHAIN_CODE,
    DOMAIN_CODE,
    STATUS,
    UNSUPPORTED_CHAIN_IDS,
    UNSUPPORTED_CHAINS,
    UNSUPPORTED_DOMAINS,
    assertSupportedChain,
    assertSupportedDomain,
    domainFromIdentifier,
    isUnsupportedChain,
    isUnsupportedDomain,
    isUnsupportedPaymentMethod,
    omitUnsupportedCurrencies,
    omitUnsupportedNetworks,
    presentDomainRecord,
    rejectIfUnsupportedChain,
    rejectIfUnsupportedDomain,
    respondDomainValidation,
    unsupportedChainError,
    unsupportedDomainError,
};
