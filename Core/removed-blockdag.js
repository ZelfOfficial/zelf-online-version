/**
 * Identifiers retired with the BlockDAG integration.
 * Shared endpoints use these checks to omit the chain and answer 400.
 */

const REMOVED_DOMAIN_NAMES = new Set(["bdag", "bdagpay"]);
const REMOVED_CHAIN_KEYS = new Set(["bdag", "blockdag", "blockdag_sc"]);
const REMOVED_CHAIN_IDS = new Set([1404]);
const REMOVED_CURRENCY_CODES = new Set(["BDAG"]);

const normalizeToken = (value) =>
    String(value || "")
        .trim()
        .toLowerCase()
        .replace(/^\./, "");

const isRemovedDomain = (domain) => REMOVED_DOMAIN_NAMES.has(normalizeToken(domain));

const isRemovedChain = (chain, chainId) => {
    if (chain != null && String(chain).trim() !== "") {
        const token = normalizeToken(chain);
        if (REMOVED_CHAIN_KEYS.has(token) || REMOVED_CURRENCY_CODES.has(String(chain).trim().toUpperCase())) {
            return true;
        }
        return false;
    }

    if (chainId != null && chainId !== "" && REMOVED_CHAIN_IDS.has(Number(chainId))) {
        return true;
    }

    return false;
};

const isRemovedRecordKey = (recordKey) => String(recordKey || "").toLowerCase().endsWith("_bdag");

const isRemovedHostname = (hostname, url = "") => {
    const host = String(hostname || "").toLowerCase();
    const requestUrl = String(url || "").toLowerCase();
    return host.includes("_bdag") || host.includes(".bdag") || (host.startsWith("localhost") && requestUrl.includes("domain=bdag"));
};

const omitRemovedDomain = (domains) => {
    if (!domains || typeof domains !== "object") return domains;
    const copy = { ...domains };
    for (const key of Object.keys(copy)) {
        if (isRemovedDomain(key)) delete copy[key];
    }
    return copy;
};

const stripNetworkMap = (networks) => {
    if (!networks || typeof networks !== "object" || Array.isArray(networks)) return networks;
    const copy = { ...networks };
    for (const key of Object.keys(copy)) {
        if (isRemovedChain(key)) delete copy[key];
    }
    return copy;
};

const stripRemovedPayment = (payment) => {
    if (!payment || typeof payment !== "object") return payment;
    const next = { ...payment };
    if (Array.isArray(next.currencies)) {
        next.currencies = next.currencies.filter((code) => !REMOVED_CURRENCY_CODES.has(String(code).toUpperCase()));
    }
    if (next.networks) next.networks = stripNetworkMap(next.networks);
    return next;
};

const unsupportedDomainError = () => {
    const error = new Error("400:UNSUPPORTED_DOMAIN");
    error.status = 400;
    error.clientCode = "UNSUPPORTED_DOMAIN";
    error.clientMessage = "UNSUPPORTED_DOMAIN";
    return error;
};

const unsupportedChainError = () => {
    const error = new Error("400:UNSUPPORTED_CHAIN");
    error.status = 400;
    error.clientCode = "UNSUPPORTED_CHAIN";
    error.clientMessage = "UNSUPPORTED_CHAIN";
    return error;
};

const rejectRemovedDomain = (ctx, domain) => {
    if (!isRemovedDomain(domain)) return false;
    ctx.status = 400;
    ctx.body = { message: "UNSUPPORTED_DOMAIN", code: "UNSUPPORTED_DOMAIN" };
    return true;
};

const rejectRemovedChain = (ctx, chain, chainId) => {
    if (!isRemovedChain(chain, chainId)) return false;
    ctx.status = 400;
    ctx.body = { message: "UNSUPPORTED_CHAIN", code: "UNSUPPORTED_CHAIN" };
    return true;
};

module.exports = {
    isRemovedDomain,
    isRemovedChain,
    isRemovedRecordKey,
    isRemovedHostname,
    omitRemovedDomain,
    stripNetworkMap,
    stripRemovedPayment,
    unsupportedDomainError,
    unsupportedChainError,
    rejectRemovedDomain,
    rejectRemovedChain,
};
