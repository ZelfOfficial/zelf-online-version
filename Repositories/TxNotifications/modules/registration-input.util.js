const { invalidRequest } = require("./tx-notifications-errors");
const { isUnsupportedChain } = require("../../../Core/unsupported-networks");
const { parseIssuedAt } = require("./registration-signature.util");
const { isSupportedNetwork, isWatchedNetwork } = require("./networks");
const { validateNetworkAddress, watchKey } = require("./address-validation.util");

/**
 * Shape checks for `POST /api/tx-notifications/devices` (400 invalid_request).
 * They run before the signature check, so they only reject what could never be
 * a valid signed request; per-network address validity is checked after the
 * signature and freshness, as the contract orders it.
 */

const PUSH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const LANGUAGE_RE = /^[A-Za-z]{2,3}([_-][A-Za-z0-9]{1,8}){0,3}$/;
const NETWORK_KEY_RE = /^[a-z0-9_-]{2,32}$/;
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const MAX_ADDRESSES = 24;

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const optionalText = (value, field, maxLength) => {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || value.length > maxLength || CONTROL_CHARS_RE.test(value)) {
        throw invalidRequest(`${field} must be a string of at most ${maxLength} characters`);
    }
    return value;
};

const isValidPushSubscriptionId = (value) => typeof value === "string" && PUSH_ID_RE.test(value);

/** Returns the normalized registration input or throws 400 invalid_request. */
const parseRegistrationBody = (body) => {
    if (!isPlainObject(body)) throw invalidRequest("body must be a JSON object");

    const { pushSubscriptionId, platform, issuedAt, signature, addresses } = body;

    if (!isValidPushSubscriptionId(pushSubscriptionId)) throw invalidRequest("pushSubscriptionId is missing or malformed");
    if (platform !== "android" && platform !== "ios") throw invalidRequest("platform must be android or ios");

    let language = "en";
    if (body.language !== undefined && body.language !== null && body.language !== "") {
        if (typeof body.language !== "string" || !LANGUAGE_RE.test(body.language)) throw invalidRequest("language is malformed");
        language = body.language.toLowerCase();
    }

    const appVersion = optionalText(body.appVersion, "appVersion", 32);
    const tagName = optionalText(body.tagName, "tagName", 128);

    if (typeof issuedAt !== "string" || parseIssuedAt(issuedAt) === null) {
        throw invalidRequest("issuedAt must be an ISO-8601 UTC timestamp such as 2026-09-30T15:04:05.000Z");
    }
    if (typeof signature !== "string" || !SIGNATURE_RE.test(signature)) throw invalidRequest("signature must be a 65-byte 0x-hex string");

    if (!isPlainObject(addresses)) throw invalidRequest("addresses must be an object of network → address");
    const keys = Object.keys(addresses);
    if (!keys.length || keys.length > MAX_ADDRESSES) throw invalidRequest(`addresses must hold 1 to ${MAX_ADDRESSES} networks`);

    for (const key of keys) {
        const value = addresses[key];
        if (!NETWORK_KEY_RE.test(key)) throw invalidRequest(`addresses has a malformed network key`);
        if (typeof value !== "string" || !value || value.length > 256 || CONTROL_CHARS_RE.test(value)) {
            throw invalidRequest(`addresses.${key} must be a non-empty single-line string`);
        }
    }
    if (typeof addresses.ethereum !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(addresses.ethereum)) {
        throw invalidRequest("addresses.ethereum is required (it signs the request)");
    }

    return { pushSubscriptionId, platform, language, appVersion, tagName, issuedAt, signature, addresses: { ...addresses } };
};

/**
 * Validates every address of a supported network (400 names the network, never
 * the address). Unknown network keys, and chains this API no longer serves, are ignored
 * so an app that still sends them keeps working. They stay part of the signed text.
 */
const resolveAddresses = (addresses) => {
    const resolved = [];

    for (const network of Object.keys(addresses).sort()) {
        if (isUnsupportedChain(network) || !isSupportedNetwork(network)) continue;

        const normalized = validateNetworkAddress(network, addresses[network]);
        if (!normalized) throw invalidRequest(`addresses.${network} is not a valid ${network} address`);

        resolved.push({
            network,
            address: addresses[network],
            key: watchKey(network, normalized.key),
            queryAddress: normalized.queryAddress,
            watched: isWatchedNetwork(network),
        });
    }

    return resolved;
};

module.exports = {
    isValidPushSubscriptionId,
    parseRegistrationBody,
    resolveAddresses,
};
