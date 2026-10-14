/**
 * Zelf ID RevenueCat purchases arriving on the v3 webhook (/api/zelf-name-service/revenue-cat).
 *
 * The Android/iOS apps sell Zelf IDs with `zelf_{premium|unlimited}_*` products (and the legacy
 * `zns_*_char_*` / `zelf_name_service_char_*` buckets). Only v4 knows how to credit them (license
 * planPricing, Zelf ID records, RevenueCatZelfIdTransaction in Mongo). Instead of copying the v4
 * persistence stack into v3, the event is handed to the v4 handler unchanged, so:
 *   - prices/plans come only from the v4 license (nothing here knows a price),
 *   - the same records and Mongo mapping v4 uses are written, by v4 itself,
 *   - an event delivered to both webhooks is credited once (v4 dedupes by event id on the record
 *     and by original_transaction_id).
 *
 * Self-contained: no shared v3 module is required or modified.
 */
const axios = require("axios");

const DEFAULT_V4_WEBHOOK_URL = "https://v4.zelf.world/api/zelf-ids/revenue-cat";

/** Same product patterns the v4 handler accepts as Zelf ID purchases (see v4 zelf-ids-revenue-cat*.module.js). */
const ZELF_ID_PRODUCT_PATTERNS = [
    /^zelf_(premium|unlimited)_(1y|2y|3y|lifetime)$/,
    /(?:^|_)char_(\d{1,2}(?:_to_\d{1,2})?)_years?_(\d+|lifetime)$/,
    /^zns_(\d{1,2}(?:_to_\d{1,2})?)_char_(\d+|lifetime)_years?$/,
];

const normalizeProductId = (productId) =>
    String(productId || "")
        .trim()
        .toLowerCase()
        .split(":")[0];

/** PRODUCT_CHANGE carries the new product in `new_product_id`. */
const isZelfIdProductEvent = (event = {}) => {
    const ids = [event.product_id, event.new_product_id].map(normalizeProductId).filter(Boolean);
    return ids.some((id) => ZELF_ID_PRODUCT_PATTERNS.some((pattern) => pattern.test(id)));
};

const forwardConfig = () => ({
    url: process.env.V4_REVENUECAT_WEBHOOK_URL || DEFAULT_V4_WEBHOOK_URL,
    authorization: process.env.V4_REVENUECAT_WEBHOOK_AUTHORIZATION || "",
    timeout: Number(process.env.V4_REVENUECAT_WEBHOOK_TIMEOUT_MS) || 20000,
});

/**
 * Hand the RevenueCat payload to the v4 Zelf ID handler.
 * Resolves with v4's `data`; throws an Error with `.status` mirroring v4 (409 = permanent,
 * 5xx/503 = RevenueCat should retry).
 * @param {Object} payload - full webhook body ({ api_version, event })
 * @param {Object} [deps] - { http } for tests
 */
const forwardToV4 = async (payload, { http = axios } = {}) => {
    const { url, authorization, timeout } = forwardConfig();

    if (!authorization) {
        const error = new Error("v4_revenuecat_forward_not_configured");
        error.status = 503;
        throw error;
    }

    let response;
    try {
        response = await http.post(url, payload, {
            headers: { Authorization: authorization, "Content-Type": "application/json" },
            timeout,
            validateStatus: () => true,
        });
    } catch (cause) {
        const error = new Error("v4_revenuecat_forward_unreachable");
        error.status = 502;
        error.cause = cause;
        throw error;
    }

    if (response.status >= 200 && response.status < 300) {
        return { forwardedTo: "v4", ...(response.data?.data !== undefined ? { result: response.data.data } : { result: response.data }) };
    }

    const message = response.data?.message || response.data?.validationError || `v4_revenuecat_forward_failed_${response.status}`;
    const error = new Error(String(message));
    // A v4 auth/config problem is ours to fix: let RevenueCat retry instead of dropping the purchase.
    error.status = response.status === 401 || response.status === 403 ? 503 : response.status;
    throw error;
};

module.exports = { ZELF_ID_PRODUCT_PATTERNS, isZelfIdProductEvent, forwardToV4, DEFAULT_V4_WEBHOOK_URL };
