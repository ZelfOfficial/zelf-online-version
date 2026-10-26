/**
 * Current Zelf ID plan and where the verified owner should go to upgrade.
 * Prices and the next plan come from the license planPricing. paymentMethod is what the lease stores.
 * Zelf ID Stripe Checkout is mode "payment" (one-off). stripe_portal runs only when the lease
 * payment method is stripe_subscription.
 */
const config = require("../../../Core/config");
const { codedError } = require("../../../Core/http-handler");
const { getDomainConfig } = require("../../Tags/config/supported-domains");
const { normalizeZelfName } = require("../../Tags/modules/zelf-name.util");
const { effectivePlan, isExpiresAtPassed, licensePaidPlansForName } = require("./zelf-id-plan.module");
const { getMonthlyAccessStatus, isEnabled: monthlyAccessEnabled } = require("./zelf-id-monthly-access.module");
const { parseLeaseDate } = require("../../Tags/modules/lease-date.util");
const { mergePlanTermIntoPublicData } = require("./zelf-id-plan-term.module");

const CRYPTO_METHODS = new Set(["crypto", "eth", "sol", "btc", "avax", "bnb", "pol", "matic", "base", "bdag", "ton"]);

const displayDuration = (duration) => {
    const raw = `${duration ?? ""}`.trim().toLowerCase();
    if (!raw) return null;
    if (raw === "lifetime" || raw === "999") return "lifetime";
    if (/^\d+y$/.test(raw)) return raw;
    if (/^\d+$/.test(raw)) return `${Number(raw)}y`;
    return raw;
};

const toIso = (value) => {
    if (!value) return null;
    const parsed = parseLeaseDate(value);
    if (!parsed.isValid()) return null;
    return parsed.toISOString();
};

/**
 * Map the lease record onto the public paymentMethod set.
 * @param {Object} publicData
 * @param {string} plan
 * @returns {"free"|"stripe"|"stripe_subscription"|"crypto"|"coupon"|"revenuecat"}
 */
const readPaymentMethod = (publicData = {}, plan) => {
    const raw = String(publicData.paymentMethod || "")
        .trim()
        .toLowerCase();

    if (raw === "stripe_subscription") return "stripe_subscription";
    if (raw === "revenuecat" || raw === "revenue_cat") return "revenuecat";
    if (raw === "coupon") return "coupon";
    if (raw === "whitelist" || raw === "free_checkout") return "whitelist";
    if (raw === "stripe") return "stripe";
    if (raw === "free") return "free";
    if (CRYPTO_METHODS.has(raw)) return "crypto";
    if (!raw && publicData.revenueCatOriginalTransactionId) return "revenuecat";
    if (plan === "free") return "free";
    return "free";
};

const nextPlansFor = (zelfName, plan, domainConfig) => {
    const offered = licensePaidPlansForName(zelfName, domainConfig);
    if (plan === "free") return offered;
    const rank = offered.indexOf(plan);
    if (rank < 0) return [];
    return offered.slice(rank + 1);
};

/**
 * Landing checkout this API already opens after Stripe (tagname, domain, duration, plan).
 * `zelfName` is included so the documented name is on the link as well.
 */
const checkoutUrl = (zelfName, plan) => {
    const normalized = normalizeZelfName(zelfName);
    // localhost:3009 is the dev landing fallback. Upgrade links stay on zelf.world unless LANDING_URL is set.
    const configured = process.env.LANDING_URL;
    const origin = String(configured && String(configured).trim() ? configured : "https://zelf.world").replace(/\/$/, "");
    const params = new URLSearchParams({
        tagname: normalized.tagName,
        domain: normalized.domain,
        duration: "1",
        plan,
        zelfName: normalized.zelfName,
    });
    return `${origin}/pricing?${params.toString()}`;
};

const openStripePortal = async (customerId) => {
    if (!config.stripe?.secretKey) throw codedError("500:STRIPE_NOT_CONFIGURED");
    const Stripe = require("stripe");
    const stripe = Stripe(config.stripe.secretKey);
    const origin = String(config.landingUrl || "https://zelf.world").replace(/\/$/, "");
    const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${origin}/pricing`,
    });
    return session.url;
};

const upgradeFor = async ({ paymentMethod, plan, duration, nextPlans, zelfName, publicData, createBillingPortal }) => {
    if (plan === "unlimited" && duration === "lifetime") {
        return { action: "none" };
    }

    if (paymentMethod === "revenuecat") {
        return { action: "mobile_store" };
    }

    if (paymentMethod === "stripe_subscription") {
        const customerId = publicData.stripeCustomerId || publicData.payment?.stripeCustomerId;
        if (!customerId) throw codedError("409:STRIPE_CUSTOMER_MISSING");
        const openPortal = createBillingPortal || openStripePortal;
        const url = await openPortal(customerId);
        return { action: "stripe_portal", url };
    }

    const nextPlan = nextPlans[0] || plan;
    return { action: "checkout", url: checkoutUrl(zelfName, nextPlan === "free" ? nextPlans[0] || "premium" : nextPlan) };
};

/**
 * @param {Object} tagObject
 * @param {Object} params
 * @param {string} params.zelfName normalized name.domain
 * @param {Object} params.domainConfig
 * @param {Function} [params.createBillingPortal]
 */
const buildMyPlan = async (tagObject, { zelfName, domainConfig, createBillingPortal, authUser } = {}) => {
    const publicData = tagObject?.publicData || {};
    await mergePlanTermIntoPublicData(publicData);
    const plan = effectivePlan(publicData, domainConfig) || "free";
    const paidTermLapsed = Boolean(publicData.planExpiresAt) && isExpiresAtPassed({ expiresAt: publicData.planExpiresAt });
    const duration = paidTermLapsed ? null : displayDuration(publicData.planDuration || publicData.duration);
    const unlimitedLifetime = plan === "unlimited" && duration === "lifetime";
    const nextPlans = unlimitedLifetime ? [] : nextPlansFor(zelfName, plan, domainConfig);
    const paymentMethod = readPaymentMethod(publicData, plan);
    const upgrade = await upgradeFor({
        paymentMethod,
        plan,
        duration,
        nextPlans,
        zelfName,
        publicData,
        createBillingPortal,
    });
    const planExpiresAt = publicData.planExpiresAt ? toIso(publicData.planExpiresAt) : null;
    const leaseExpiresAt = publicData.expiresAt ? toIso(publicData.expiresAt) : null;

    const result = {
        zelfName,
        plan,
        planExpiresAt,
        leaseExpiresAt,
        // Name lease. Older clients read this field as the name's expiry.
        expiresAt: leaseExpiresAt,
        duration,
        paymentMethod,
        nextPlans,
        upgrade,
    };

    if (monthlyAccessEnabled()) {
        try {
            result.monthlyAccess = await getMonthlyAccessStatus({
                zelfName,
                publicData,
                domainConfig,
                plan,
                authUser,
                includeHistory: true,
            });
        } catch (_error) {
            result.monthlyAccess = {
                enabled: true,
                zelfName,
                plan,
                status: "unavailable",
                openAllowed: true,
            };
        }
    }

    return result;
};

const tagNotFound = () => {
    const error = new Error("404:TAG_NOT_FOUND");
    error.clientCode = "TAG_NOT_FOUND";
    error.clientMessage = "TAG_NOT_FOUND";
    error.status = 404;
    return error;
};

const getMyPlan = async ({ zelfName, authUser } = {}, deps = {}) => {
    const normalized = normalizeZelfName(zelfName);
    if (!normalized.zelfName) throw tagNotFound();

    const domainConfig = (deps.getDomainConfig || getDomainConfig)(normalized.domain);
    const searchTag = deps.searchTag || require("./zelf-id.module").searchTag;
    const found = await searchTag(
        { tagName: normalized.tagName, domain: normalized.domain, domainConfig, environment: "all" },
        deps.authUser || authUser || {}
    );

    if (!found || found.available || !found.tagObject) throw tagNotFound();

    return buildMyPlan(found.tagObject, {
        zelfName: normalized.zelfName,
        domainConfig,
        createBillingPortal: deps.createBillingPortal,
        authUser: deps.authUser || authUser || {},
    });
};

module.exports = {
    buildMyPlan,
    checkoutUrl,
    displayDuration,
    getMyPlan,
    readPaymentMethod,
};
