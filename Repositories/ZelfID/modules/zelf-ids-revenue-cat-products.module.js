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

const PLAN_PRICING_LENGTH_BUCKETS = ["1-5", "6-15", "16-27"];

/**
 * Default `tags.payment.planPricing` cells for Zelf ID in-app subscriptions when the license omits them.
 * @returns {{ premium: Object, unlimited: Object }}
 */
const defaultZelfIdPlanPricingTables = () => {
    const premium = {};
    const unlimited = {};

    for (const bucket of PLAN_PRICING_LENGTH_BUCKETS) {
        premium[bucket] = { ...APP_PLAN_USD.premium };
        unlimited[bucket] = { ...APP_PLAN_USD.unlimited };
    }

    for (let length = 1; length <= 5; length += 1) {
        premium[length] = { ...premium["1-5"] };
        unlimited[length] = { ...unlimited["1-5"] };
    }

    return { premium, unlimited };
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
    defaultZelfIdPlanPricingTables,
    parseSubscriptionProductId,
};
