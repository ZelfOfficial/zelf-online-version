/**
 * RevenueCat store product ids → Zelf ID plan + term, and default in-app plan pricing.
 *
 * App Store / Play products (Play may append `:base-plan-id`):
 *   zelf_premium_1y, zelf_unlimited_1y — auto-renewing subscription (+1 year per INITIAL_PURCHASE / RENEWAL)
 *   zelf_premium_2y, zelf_unlimited_2y — one-time (+2 years)
 *   zelf_premium_3y, zelf_unlimited_3y — one-time (+3 years)
 *   zelf_premium_lifetime, zelf_unlimited_lifetime — lifetime (100-year sentinel)
 */

const SUBSCRIPTION_PRODUCT_RE = /^zelf_(premium|unlimited)_(1y)$/i;
const ONE_TIME_PRODUCT_RE = /^zelf_(premium|unlimited)_(2y|3y|lifetime)$/i;

/** @type {Record<string, { plan: "premium"|"unlimited", duration: string, subscription: boolean }>} */
const ZELF_ID_REVENUECAT_PRODUCT_MAP = Object.freeze({
    zelf_premium_1y: { plan: "premium", duration: "1", subscription: true },
    zelf_unlimited_1y: { plan: "unlimited", duration: "1", subscription: true },
    zelf_premium_2y: { plan: "premium", duration: "2", subscription: false },
    zelf_unlimited_2y: { plan: "unlimited", duration: "2", subscription: false },
    zelf_premium_3y: { plan: "premium", duration: "3", subscription: false },
    zelf_unlimited_3y: { plan: "unlimited", duration: "3", subscription: false },
    zelf_premium_lifetime: { plan: "premium", duration: "lifetime", subscription: false },
    zelf_unlimited_lifetime: { plan: "unlimited", duration: "lifetime", subscription: false },
});

const APP_PLAN_USD = Object.freeze({
    premium: { 1: 29, 2: 43.49, 3: 56.99, lifetime: 144.99 },
    unlimited: { 1: 99, 2: 148.99, 3: 192.99, lifetime: 494.99 },
});

/** Durations sold for Zelf ID plans. No 4- or 5-year options. */
const ZELF_ID_PLAN_DURATIONS = Object.freeze(["1", "2", "3", "lifetime"]);

const SHORT_NAME_MAX_LENGTH = 5;
const MAX_NAME_LENGTH = 27;

/**
 * Canonical `tags.payment.planPricing` for the `zelf` license.
 * Premium exists only for 6+ character names; unlimited covers every length (1–27).
 * Keys match the license table shape: single lengths plus the `6-15` bucket.
 * @returns {{ premium: Object, unlimited: Object }}
 */
const defaultZelfIdPlanPricingTables = () => {
    const premium = { "6-15": { ...APP_PLAN_USD.premium } };
    const unlimited = { "6-15": { ...APP_PLAN_USD.unlimited } };

    for (let length = 1; length <= MAX_NAME_LENGTH; length += 1) {
        if (length >= 6 && length <= 15) continue;
        unlimited[length] = { ...APP_PLAN_USD.unlimited };
        if (length > SHORT_NAME_MAX_LENGTH) premium[length] = { ...APP_PLAN_USD.premium };
    }

    return { premium, unlimited };
};

/**
 * Overwrite `tags.payment.planPricing` on a `zelf` license JSON with the canonical tables,
 * so a stale hosted license (IPFS) cannot advertise old prices. Other domains are untouched.
 * @param {Object} licenseJson
 * @returns {Object} same object
 */
const applyZelfIdPlanPricing = (licenseJson) => {
    if (!licenseJson || typeof licenseJson !== "object") return licenseJson;
    if (String(licenseJson.name || "").toLowerCase() !== "zelf") return licenseJson;
    licenseJson.tags = licenseJson.tags || {};
    licenseJson.tags.payment = licenseJson.tags.payment || {};
    licenseJson.tags.payment.planPricing = defaultZelfIdPlanPricingTables();
    return licenseJson;
};

/**
 * @param {string} productId
 * @returns {{ plan: "premium"|"unlimited", duration: string, subscription: boolean }|null}
 */
const parseSubscriptionProductId = (productId) => {
    const id = String(productId || "")
        .trim()
        .toLowerCase()
        .split(":")[0];

    if (ZELF_ID_REVENUECAT_PRODUCT_MAP[id]) {
        return { ...ZELF_ID_REVENUECAT_PRODUCT_MAP[id] };
    }

    const sub = id.match(SUBSCRIPTION_PRODUCT_RE);
    if (sub) {
        return { plan: sub[1], duration: "1", subscription: true };
    }

    const oneTime = id.match(ONE_TIME_PRODUCT_RE);
    if (oneTime) {
        const raw = oneTime[2];
        const duration = raw === "lifetime" ? "lifetime" : raw.replace("y", "");
        return { plan: oneTime[1], duration, subscription: false };
    }

    return null;
};

module.exports = {
    ZELF_ID_REVENUECAT_PRODUCT_MAP,
    APP_PLAN_USD,
    ZELF_ID_PLAN_DURATIONS,
    defaultZelfIdPlanPricingTables,
    applyZelfIdPlanPricing,
    parseSubscriptionProductId,
};
