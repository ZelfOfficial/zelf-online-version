/**
 * Zelf ID v4 plan stamps and legacy unpaid `.hold` helpers.
 * Prices come from the domain license (`tags.payment.pricingTable` via
 * `domainConfig.getPrice`). Do not hardcode dollar amounts here.
 *
 * 1–5 and 6–27 characters lease as `free` with a 100-year sentinel. Short names
 * may upgrade to **unlimited** only; long names may choose premium or unlimited.
 * New leases no longer create `.hold` pins; existing holds still convert on payment.
 * An expired paid year reads as `plan: free`. Paid Lifetime stores 100 years from
 * payment. Upgrade expiry starts from payment time unless the name already has an
 * active paid lease (v4 premium/unlimited, or v3.6 planless with renewedAt / price > 0).
 */
const moment = require("moment");

/** Unpaid short-name hold window. Override via `ZELF_ID_RESERVATION_AMOUNT` / `ZELF_ID_RESERVATION_UNIT` (e.g. `5` + `hour` to revert). */
const ZELF_ID_RESERVATION_DURATION = {
    amount: Number(process.env.ZELF_ID_RESERVATION_AMOUNT || 1),
    unit: process.env.ZELF_ID_RESERVATION_UNIT || "year",
};

/** @deprecated Prefer `ZELF_ID_RESERVATION_DURATION` or `getReservationExpiresAt`. */
const ZELF_ID_RESERVATION_HOURS = moment
    .duration(ZELF_ID_RESERVATION_DURATION.amount, ZELF_ID_RESERVATION_DURATION.unit)
    .asHours();

/**
 * UTC `expiresAt` for a new unpaid `.hold` reservation (same format as lease stamps).
 * @returns {string}
 */
const getReservationExpiresAt = () =>
    moment()
        .add(ZELF_ID_RESERVATION_DURATION.amount, ZELF_ID_RESERVATION_DURATION.unit)
        .format("YYYY-MM-DD HH:mm:ss");
const SHORT_NAME_MAX = 5;
const LONG_NAME_MAX = 27;
const FREE_EXPIRATION_YEARS = 100;
const LIFETIME_EXPIRATION_YEARS = 100;
const PAID_HORIZON_YEARS = 50;
const HOLD_NAME_RE = /\.hold(\.|$)/i;

/**
 * Bare local name (before TLD), without a trailing `.hold`.
 * @param {string} [tagName]
 * @returns {string}
 */
const getBareName = (tagName = "") =>
    String(tagName || "")
        .trim()
        .replace(/\.hold$/i, "")
        .split(".")[0];

/**
 * Unpaid reservation pin: `alice.zelf.hold`, never `alice.hold`.
 * @param {string} [tagName]
 * @param {string} [domain]
 * @param {string} [holdSuffix]
 * @returns {string}
 */
const getReservationPinName = (tagName, domain = "zelf", holdSuffix = ".hold") => {
    const bare = getBareName(tagName);
    const tld = String(domain || "zelf")
        .trim()
        .replace(/^\./, "")
        .replace(/\.hold$/i, "");
    const suffix = String(holdSuffix || ".hold").startsWith(".") ? holdSuffix : `.${holdSuffix}`;

    return `${bare}.${tld}${suffix}`;
};

/**
 * @param {string} [tagName]
 * @returns {number}
 */
const getBareNameLength = (tagName) => getBareName(tagName).length;

/**
 * @param {string} [tagName]
 * @returns {boolean}
 */
const isShortZelfIdName = (tagName) => {
    const length = getBareNameLength(tagName);
    return length > 0 && length <= SHORT_NAME_MAX;
};

/**
 * @deprecated New leases no longer create `.hold` reservations. Always `false`.
 * Use `isShortZelfIdName` for 1–5 character plan and pricing rules.
 * @param {string} [_tagName]
 * @returns {boolean}
 */
const requiresHoldReservation = (_tagName) => false;

/**
 * Plans a name may use. Short names cannot be premium or lease-only free.
 * @param {string} [tagName]
 * @returns {Array<"free"|"premium"|"unlimited">}
 */
const allowedPlansForName = (tagName) => {
    const length = getBareNameLength(tagName);
    if (length > 0 && length <= SHORT_NAME_MAX) return ["free", "unlimited"];
    if (length >= 6 && length <= LONG_NAME_MAX) return ["free", "premium", "unlimited"];
    return [];
};

/**
 * Paid-plan stamp. Short names cannot be premium. Long names pick premium or unlimited.
 * @param {Object|string} [tagNameOrParams]
 * @param {string} [tagNameOrParams.tagName]
 * @param {string} [tagNameOrParams.requestedPlan]
 * @returns {"premium"|"unlimited"}
 */
const resolvePaidPlan = (tagNameOrParams, requestedPlan) => {
    const tagName = typeof tagNameOrParams === "string" ? tagNameOrParams : tagNameOrParams?.tagName;
    const plan = typeof tagNameOrParams === "string" ? requestedPlan : tagNameOrParams?.requestedPlan;

    if (isShortZelfIdName(tagName)) return "unlimited";
    if (plan === "unlimited") return "unlimited";
    return "premium";
};

/**
 * License quote plus the plan this name is allowed to take.
 * Dollar amounts come from `domainConfig.getPrice` (license pricing table).
 * @param {Object} [params]
 * @param {string} [params.tagName]
 * @param {string|number} [params.duration]
 * @param {string} [params.referralTagName]
 * @param {Object} params.domainConfig
 * @param {string} [params.requestedPlan]
 * @returns {Object}
 */
const getZelfIdPrice = ({ tagName, duration = "1", referralTagName = "", domainConfig, requestedPlan } = {}) => {
    if (typeof domainConfig?.getPrice !== "function") {
        throw new Error("409:license_price_required");
    }

    const quotePlan =
        isShortZelfIdName(tagName) && requestedPlan !== "premium" && requestedPlan !== "unlimited"
            ? "unlimited"
            : requestedPlan === "premium" || requestedPlan === "unlimited"
              ? requestedPlan
              : undefined;
    const quote = domainConfig.getPrice(tagName, normalizePaymentDuration(duration), referralTagName, quotePlan ? { plan: quotePlan } : {});
    const allowedPlans = allowedPlansForName(tagName);
    const plan =
        requestedPlan === "premium" || requestedPlan === "unlimited"
            ? isShortZelfIdName(tagName) && requestedPlan === "premium"
              ? "unlimited"
              : requestedPlan
            : "free";

    return {
        ...quote,
        plan,
        allowedPlans,
    };
};

/**
 * Checkout quote: priced with the same paid plan the payment will stamp.
 * Without an explicit plan a long name pays (and is stamped) premium, never
 * the Tags default table; short names always pay unlimited.
 * @param {Object} [params] - same as `getZelfIdPrice`
 * @returns {Object}
 */
const getZelfIdCheckoutPrice = ({ tagName, duration = "1", referralTagName = "", domainConfig, requestedPlan } = {}) =>
    getZelfIdPrice({
        tagName,
        duration,
        referralTagName,
        domainConfig,
        requestedPlan: resolvePaidPlan({ tagName, requestedPlan }),
    });

/**
 * Plan at lease time. All valid names (1–27 chars) start `free`.
 * @param {Object} params
 * @param {string} [params.tagName]
 * @returns {"free"}
 */
const resolveZelfIdPlan = () => "free";

/**
 * Confirm plan when the license quote is already `$0` (100% referral / leftover).
 * Returns undefined so the caller stamps `free` via `resolveZelfIdPlan`.
 * @param {Object} [params]
 * @param {string} [params.tagName]
 * @param {number|string} [params.price]
 * @returns {undefined}
 */
const resolveComplimentaryPlan = ({ price } = {}) => {
    if (Number(price) !== 0) return undefined;
    return undefined;
};

/**
 * API / UI duration → license key. `999` is the checkout alias for `lifetime`.
 * @param {string|number} [duration]
 * @returns {"1"|"2"|"3"|"4"|"5"|"lifetime"}
 */
const normalizePaymentDuration = (duration = "1") => {
    const raw = `${duration ?? "1"}`.trim().toLowerCase();
    if (raw === "999" || raw === "lifetime") return "lifetime";
    if (["1", "2", "3", "4", "5"].includes(raw)) return raw;
    return "1";
};

/**
 * @param {string|number} [duration]
 * @returns {boolean}
 */
const isLifetimeDuration = (duration) => normalizePaymentDuration(duration) === "lifetime";

/**
 * Years added to a paid expiration. Lifetime stamps 100 years.
 * @param {string|number} [duration]
 * @returns {number}
 */
const paymentDurationYears = (duration) => {
    if (isLifetimeDuration(duration)) return LIFETIME_EXPIRATION_YEARS;
    const years = Number(normalizePaymentDuration(duration));
    return Number.isFinite(years) && years > 0 ? years : 1;
};

/**
 * Canonical name used after a hold is paid: `alice.zelf`, never `*.hold`.
 * @param {string} [tagName]
 * @param {string} [domain]
 * @returns {string}
 */
const getCanonicalMainnetName = (tagName, domain = "zelf") => {
    const tld = String(domain || "zelf")
        .trim()
        .replace(/^\./, "")
        .replace(/\.hold$/i, "");
    return `${getBareName(tagName)}.${tld}`;
};

/**
 * Historical hold layouts: `name.domain.hold`, `name.hold`, `name.hold.domain`.
 * @param {string} [tagName]
 * @returns {boolean}
 */
const isHoldName = (tagName = "") => HOLD_NAME_RE.test(String(tagName || "").trim());

/**
 * Plan after a successful payment. Short → unlimited. Long → requested premium or unlimited.
 * @param {Object} [params]
 * @param {string} [params.tagName]
 * @param {string} [params.requestedPlan]
 * @returns {"premium"|"unlimited"}
 */
const resolveUpgradePlan = ({ tagName, requestedPlan } = {}) => resolvePaidPlan({ tagName, requestedPlan });

/**
 * @param {Object} [publicData]
 * @returns {boolean}
 */
const isUnpaidReservation = (publicData = {}) => {
    if (publicData.type === "hold" || publicData.type === "reserved") return true;
    if (String(publicData.status || "").toLowerCase() === "hold") return true;
    return isHoldName(publicData.tagName || publicData.zelfName);
};

/**
 * @param {Object} [publicData]
 * @returns {boolean}
 */
const isExpiresAtPassed = (publicData = {}) => {
    if (!publicData.expiresAt) return false;

    return moment(publicData.expiresAt, "YYYY-MM-DD HH:mm:ss", true).isValid()
        ? moment(publicData.expiresAt, "YYYY-MM-DD HH:mm:ss").isBefore(moment())
        : moment(publicData.expiresAt).isBefore(moment());
};

/**
 * Stored / inferred plan. Expired mainnet is still the name, but `free`.
 * Planless legacy Tags mainnet (no `.hold`) reads as premium (6+) or unlimited (1–5).
 * @param {Object} [publicData]
 * @returns {"free"|"premium"|"unlimited"|undefined}
 */
const effectivePlan = (publicData = {}) => {
    if (isUnpaidReservation(publicData)) return publicData.plan;

    if ((publicData.type === "mainnet" || !publicData.type) && isExpiresAtPassed(publicData)) return "free";

    const tagName = publicData.tagName || publicData.zelfName;
    if (isShortZelfIdName(tagName) && publicData.plan === "premium") return "unlimited";

    if (publicData.plan === "free" || publicData.plan === "premium" || publicData.plan === "unlimited") {
        return publicData.plan;
    }

    if (isShortZelfIdName(tagName)) return "unlimited";
    if (getBareNameLength(tagName) >= 6) return "premium";
    return publicData.plan;
};

const isReservationExpired = (publicData = {}) => isExpiresAtPassed(publicData);

/**
 * Unpaid hold/reserved whose reservation window has passed.
 * Paid mainnet records (free/premium/unlimited) are never expired reservations.
 * @param {Object} [publicData]
 * @returns {boolean}
 */
const isUnpaidExpiredReservation = (publicData = {}) => {
    if (publicData.type === "mainnet") return false;
    if (publicData.plan === "free" || publicData.plan === "premium" || publicData.plan === "unlimited") return false;

    return isUnpaidReservation(publicData) && isReservationExpired(publicData);
};

/**
 * Years remaining until `expiresAt`. Negative when already expired.
 * @param {string} [expiresAt]
 * @returns {number}
 */
const remainingExpirationYears = (expiresAt) => {
    if (!expiresAt) return 0;
    const parsed = moment(expiresAt, "YYYY-MM-DD HH:mm:ss", true).isValid()
        ? moment(expiresAt, "YYYY-MM-DD HH:mm:ss")
        : moment(expiresAt);
    return parsed.diff(moment(), "years", true);
};

/**
 * v3.6 Tags never wrote `plan`. A leftover 1-year `expiresAt` is not proof of
 * payment (`confirmFreeTag` stamps the same shape). Prior pay is `renewedAt`
 * or a stored `price` above 0.
 * @param {Object} [publicData]
 * @returns {boolean}
 */
const hasV36PaidEvidence = (publicData = {}) => {
    if (publicData.plan === "free" || publicData.plan === "premium" || publicData.plan === "unlimited") {
        return false;
    }
    if (publicData.renewedAt) return true;
    const price = Number(publicData.price);
    return Number.isFinite(price) && price > 0;
};

/**
 * Add onto stored expiry only after a real prior purchase that is still active.
 * Free, planless v3.6 without pay evidence, holds, and expired paid years reset.
 * @param {Object} [publicData]
 * @returns {boolean}
 */
const hasActivePaidLease = (publicData = {}) => {
    if (isUnpaidReservation(publicData) || isExpiresAtPassed(publicData)) return false;
    if (publicData.plan === "premium" || publicData.plan === "unlimited") return true;
    if (publicData.plan === "free") return false;
    return hasV36PaidEvidence(publicData);
};

/**
 * Paid expiration after a 1–5 year or Lifetime purchase.
 * Free / planless v3.6 without prior pay / expired / hold → reset from now.
 * Active v4 premium/unlimited or v3.6 paid evidence → add to stored expiration.
 * Lifetime always resets to 100 years from today.
 * @param {Object} [params]
 * @param {Object} [params.publicData]
 * @param {string|number} [params.duration]
 * @param {number} [params.durationYears]
 * @returns {string}
 */
const resolvePaidExpiresAt = ({ publicData = {}, duration, durationYears } = {}) => {
    const years = durationYears ?? paymentDurationYears(duration);
    const fromNow = () =>
        moment()
            .add(isLifetimeDuration(duration) ? LIFETIME_EXPIRATION_YEARS : years || 1, "year")
            .format("YYYY-MM-DD HH:mm:ss");

    if (isLifetimeDuration(duration)) return fromNow();
    if (!hasActivePaidLease(publicData) || !publicData.expiresAt) return fromNow();

    const parsed = moment(publicData.expiresAt, "YYYY-MM-DD HH:mm:ss", true).isValid()
        ? moment(publicData.expiresAt, "YYYY-MM-DD HH:mm:ss")
        : moment(publicData.expiresAt);
    return parsed.add(years || 1, "year").format("YYYY-MM-DD HH:mm:ss");
};

/**
 * Duration written after payment. Free / planless v3.6 without prior pay resets;
 * active paid yearly adds; lifetime is `lifetime`.
 * @param {Object} [params]
 * @param {Object} [params.publicData]
 * @param {string|number} [params.duration]
 * @returns {string}
 */
const resolvePaidDurationStamp = ({ publicData = {}, duration } = {}) => {
    const normalized = normalizePaymentDuration(duration);
    if (normalized === "lifetime") return "lifetime";
    if (!hasActivePaidLease(publicData)) return normalized;

    const previous = Number(publicData.duration);
    if (Number.isFinite(previous) && previous > 0 && previous < PAID_HORIZON_YEARS) {
        return `${previous + Number(normalized)}`;
    }

    return normalized;
};

/**
 * Payment-confirmation stamp for a v4 hold → paid mainnet plan.
 * Legacy v3 records get no plan from this helper; `buildMetadata` still persists one.
 * @param {Object} params
 * @param {string} [params.tagName]
 * @param {number} [params.encryptVersion]
 * @param {boolean} [params.isHold]
 * @param {number} [params.durationYears]
 * @param {string|number} [params.duration]
 * @param {Object} [params.publicData]
 * @returns {{ plan?: "premium"|"unlimited", expiresAt?: string }}
 */
const resolveV4PaymentStamp = ({ tagName, encryptVersion, durationYears, duration, requestedPlan, publicData } = {}) => {
    if (encryptVersion != null && Number(encryptVersion) !== 4) return {};

    return {
        plan: resolveUpgradePlan({ tagName, requestedPlan }),
        expiresAt: resolvePaidExpiresAt({ publicData, duration, durationYears }),
    };
};

module.exports = {
    ZELF_ID_RESERVATION_DURATION,
    ZELF_ID_RESERVATION_HOURS,
    getReservationExpiresAt,
    SHORT_NAME_MAX,
    LONG_NAME_MAX,
    FREE_EXPIRATION_YEARS,
    LIFETIME_EXPIRATION_YEARS,
    PAID_HORIZON_YEARS,
    getBareName,
    getBareNameLength,
    getReservationPinName,
    getCanonicalMainnetName,
    isShortZelfIdName,
    requiresHoldReservation,
    allowedPlansForName,
    resolvePaidPlan,
    getZelfIdPrice,
    getZelfIdCheckoutPrice,
    resolveZelfIdPlan,
    resolveComplimentaryPlan,
    resolveUpgradePlan,
    effectivePlan,
    isHoldName,
    isUnpaidReservation,
    isExpiresAtPassed,
    isReservationExpired,
    isUnpaidExpiredReservation,
    normalizePaymentDuration,
    isLifetimeDuration,
    paymentDurationYears,
    remainingExpirationYears,
    hasV36PaidEvidence,
    hasActivePaidLease,
    resolvePaidExpiresAt,
    resolvePaidDurationStamp,
    resolveV4PaymentStamp,
};
