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
const { formatLeaseDate, parseLeaseDate } = require("../../Tags/modules/lease-date.util");

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
const getReservationExpiresAt = () => formatLeaseDate(ZELF_ID_RESERVATION_DURATION.amount, ZELF_ID_RESERVATION_DURATION.unit);
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
 * The domain license for a name: the one passed in, else the cached license for the name's TLD.
 * @param {string} [tagName]
 * @param {Object} [domainConfig]
 * @returns {Object|undefined}
 */
const licenseForName = (tagName, domainConfig) => {
    if (domainConfig) return domainConfig;
    const tld = String(tagName || "").trim().replace(/\.hold$/i, "").split(".")[1];
    try {
        const { getDomainConfig } = require("../../Tags/config/supported-domains");
        return getDomainConfig(String(tld || "zelf").toLowerCase()) || undefined;
    } catch (_error) {
        return undefined;
    }
};

/** True when the cell key ("6-15", "16-27" or a single length "3") covers `length`. */
const lengthKeyCovers = (key, length) => {
    const range = /^(\d+)-(\d+)$/.exec(String(key));
    return range ? length >= Number(range[1]) && length <= Number(range[2]) : Number(key) === length;
};

/**
 * Name length the license accepts (`tags.minLength` / `tags.maxLength`); unset bounds are not enforced.
 * @param {number} length
 * @param {Object} [domainConfig]
 * @returns {boolean}
 */
const isLengthWithinLicense = (length, domainConfig) => {
    if (!(length > 0)) return false;
    const min = Number(domainConfig?.tags?.minLength);
    const max = Number(domainConfig?.tags?.maxLength);
    if (Number.isFinite(min) && min > 0 && length < min) return false;
    if (Number.isFinite(max) && max > 0 && length > max) return false;
    return true;
};

/**
 * Paid plans the license prices for this name's length, cheapest first (cheapest = default paid plan).
 * Plans, length groups and durations all come from `tags.payment.planPricing`.
 * @param {string} [tagName]
 * @param {Object} [domainConfig]
 * @returns {string[]}
 */
const licensePaidPlansForName = (tagName, domainConfig) => {
    const license = licenseForName(tagName, domainConfig);
    const length = getBareNameLength(tagName);
    const planPricing = license?.tags?.payment?.planPricing;
    if (!planPricing || typeof planPricing !== "object" || !isLengthWithinLicense(length, license)) return [];

    const offered = [];
    for (const [plan, table] of Object.entries(planPricing)) {
        if (!table || typeof table !== "object") continue;
        let cheapest = Infinity;
        for (const [key, cells] of Object.entries(table)) {
            if (!lengthKeyCovers(key, length) || !cells || typeof cells !== "object") continue;
            for (const price of Object.values(cells)) {
                if (typeof price === "number" && Number.isFinite(price)) cheapest = Math.min(cheapest, price);
            }
        }
        if (cheapest !== Infinity) offered.push({ plan, cheapest });
    }

    return offered.sort((a, b) => a.cheapest - b.cheapest).map((entry) => entry.plan);
};

/**
 * True when the license prices `plan` for this name's length.
 * @param {string} plan
 * @param {string} [tagName]
 * @param {Object} [domainConfig]
 * @returns {boolean}
 */
const isPlanOfferedForName = (plan, tagName, domainConfig) => licensePaidPlansForName(tagName, domainConfig).includes(plan);

/**
 * Legacy name for "the license does not offer premium for this length" (today: 1–5 chars).
 * Derived from the license, not a fixed length.
 * @param {string} [tagName]
 * @param {Object} [domainConfig]
 * @returns {boolean}
 */
const isShortZelfIdName = (tagName, domainConfig) => {
    const offered = licensePaidPlansForName(tagName, domainConfig);
    return offered.length > 0 && !offered.includes("premium");
};

/**
 * @deprecated New leases no longer create `.hold` reservations. Always `false`.
 * @param {string} [_tagName]
 * @returns {boolean}
 */
const requiresHoldReservation = (_tagName) => false;

/**
 * Plans a name may use: `free` (every leasable name starts free; the license has no free cell)
 * plus every paid plan the license prices for the name's length. Empty when the license has none.
 * @param {string} [tagName]
 * @param {Object} [domainConfig]
 * @returns {string[]}
 */
const allowedPlansForName = (tagName, domainConfig) => {
    const paid = licensePaidPlansForName(tagName, domainConfig);
    if (!paid.length) return [];
    const license = licenseForName(tagName, domainConfig);
    const pricedFree = Boolean(license?.tags?.payment?.planPricing?.free);
    const ordered = Object.keys(license.tags.payment.planPricing).filter((plan) => paid.includes(plan));
    return pricedFree ? ordered : ["free", ...ordered];
};

/**
 * Paid-plan stamp: the requested plan when the license offers it for this name,
 * else the cheapest plan the license offers for this length.
 * @param {Object|string} [tagNameOrParams]
 * @param {string} [tagNameOrParams.tagName]
 * @param {string} [tagNameOrParams.requestedPlan]
 * @param {Object} [tagNameOrParams.domainConfig]
 * @param {string} [requestedPlan]
 * @returns {string|undefined}
 */
const resolvePaidPlan = (tagNameOrParams, requestedPlan) => {
    const tagName = typeof tagNameOrParams === "string" ? tagNameOrParams : tagNameOrParams?.tagName;
    const plan = typeof tagNameOrParams === "string" ? requestedPlan : tagNameOrParams?.requestedPlan;
    const domainConfig = typeof tagNameOrParams === "object" ? tagNameOrParams?.domainConfig : undefined;

    const offered = licensePaidPlansForName(tagName, domainConfig);
    if (plan && offered.includes(plan)) return plan;
    return offered[0];
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

    // An explicit paid plan is quoted as-is: getPrice throws 409 when the license does not price it.
    const quotePlan = requestedPlan && requestedPlan !== "free" ? requestedPlan : undefined;
    const quote = domainConfig.getPrice(tagName, normalizePaymentDuration(duration), referralTagName, {
        ...(quotePlan ? { plan: quotePlan } : {}),
        zelfIdQuote: true,
    });
    const allowedPlans = allowedPlansForName(tagName, domainConfig);
    const plan = quotePlan || "free";

    return {
        ...quote,
        plan,
        allowedPlans,
    };
};

/**
 * Reject a plan/duration the license does not price for this name (e.g. 4y, premium on 1–5 chars).
 * @param {Object} params
 * @param {Object} params.domainConfig
 * @param {string} params.tagName
 * @param {"premium"|"unlimited"} params.plan
 * @param {string|number} params.duration
 */
const assertLicenseOffersPlan = ({ domainConfig, tagName, plan, duration }) => {
    if (typeof domainConfig?.licensePlanDurations !== "function") throw new Error("409:license_price_required");
    const offered = domainConfig.licensePlanDurations(plan, getBareNameLength(tagName));
    const raw = `${duration ?? ""}`.trim().toLowerCase();
    const wanted = raw === "999" ? "lifetime" : raw;
    if (!offered.includes(wanted)) {
        throw new Error(offered.length ? "409:plan_duration_not_offered_by_license" : "409:plan_not_offered_for_name");
    }
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
        requestedPlan: resolvePaidPlan({ tagName, requestedPlan, domainConfig }),
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
 * Any whole number of years is passed through; whether it is offered is decided by the license.
 * @returns {string}
 */
const normalizePaymentDuration = (duration = "1") => {
    const raw = `${duration ?? "1"}`.trim().toLowerCase();
    if (raw === "999" || raw === "lifetime") return "lifetime";
    const years = raw.endsWith("y") ? raw.slice(0, -1) : raw;
    if (/^\d+$/.test(years) && Number(years) > 0) return String(Number(years));
    return raw || "1";
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
const resolveUpgradePlan = ({ tagName, requestedPlan, domainConfig } = {}) => resolvePaidPlan({ tagName, requestedPlan, domainConfig });

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
    return parseLeaseDate(publicData.expiresAt).isBefore(moment.utc());
};

/**
 * Stored / inferred plan. Expired mainnet is still the name, but `free`.
 * Planless legacy Tags mainnet (no `.hold`) reads as premium (6+) or unlimited (1–5).
 * @param {Object} [publicData]
 * @returns {"free"|"premium"|"unlimited"|undefined}
 */
const effectivePlan = (publicData = {}, domainConfig) => {
    if (isUnpaidReservation(publicData)) return publicData.plan;

    // A Free name that bought a term keeps the 100-year lease in `expiresAt`.
    // The paid plan ends at `planExpiresAt`. Read time only; no cron.
    if (publicData.planExpiresAt) {
        if (isExpiresAtPassed({ expiresAt: publicData.planExpiresAt })) return "free";
        const active = String(publicData.plan || "").toLowerCase();
        if (active === "premium" || active === "unlimited") return active;
    }

    if ((publicData.type === "mainnet" || !publicData.type) && isExpiresAtPassed(publicData) && !publicData.planExpiresAt) return "free";

    const tagName = publicData.tagName || publicData.zelfName;
    const offered = licensePaidPlansForName(tagName, domainConfig);
    if (publicData.plan === "free") return "free";

    // A stored paid plan the license no longer offers for this length reads as the license default.
    if (publicData.plan) return offered.length && !offered.includes(publicData.plan) ? offered[0] : publicData.plan;

    // Planless legacy mainnet: the license default paid plan for this length.
    return offered[0] ?? publicData.plan;
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
/**
 * A Free registration (plan `free`, or a 100-year sentinel with no paid plan).
 * Buying a term must not move `expiresAt`. Paid-from-the-start names have no `planExpiresAt`
 * and are not matched here.
 * @param {Object} [publicData]
 * @returns {boolean}
 */
const isFreeOriginLease = (publicData = {}) => {
    if (publicData.planExpiresAt) return false;
    const plan = String(publicData.plan || "").toLowerCase();
    if (plan === "free") return true;
    if (plan === "premium" || plan === "unlimited") return false;
    const years = Number(publicData.duration);
    return Number.isFinite(years) && years >= FREE_EXPIRATION_YEARS;
};

/**
 * Plan Zelf Keys `/limits` should use. #207 `vaultPlanFromTag` already calls `effectivePlan`;
 * keep that call. An elapsed `planExpiresAt` reads as `free`, so free caps apply without a migration.
 * @param {Object} [publicData]
 * @param {Object} [domainConfig]
 * @returns {"free"|"premium"|"unlimited"}
 */
const planForLimits = (publicData, domainConfig) => {
    const plan = effectivePlan(publicData, domainConfig);
    return plan === "premium" || plan === "unlimited" ? plan : "free";
};

const hasActivePaidLease = (publicData = {}) => {
    if (isUnpaidReservation(publicData) || isExpiresAtPassed(publicData)) return false;
    const plan = String(publicData.plan || "").toLowerCase();
    if (plan === "premium" || plan === "unlimited") return true;
    if (plan === "free") return false;
    // The free-lease sentinel (100 years) is not a paid term to extend.
    const storedYears = Number(publicData.duration);
    if (Number.isFinite(storedYears) && storedYears >= PAID_HORIZON_YEARS) return false;
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
    const fromNow = () => formatLeaseDate(isLifetimeDuration(duration) ? LIFETIME_EXPIRATION_YEARS : years || 1, "year");

    if (!hasActivePaidLease(publicData) || !publicData.expiresAt) return fromNow();

    const parsed = parseLeaseDate(publicData.expiresAt);

    // An active paid lease is never shortened: lifetime keeps its horizon, and a
    // lifetime purchase on top of a longer stored expiry keeps the longer one.
    if (isLifetimeDuration(duration)) {
        const lifetime = fromNow();
        return parseLeaseDate(lifetime).isAfter(parsed) ? lifetime : parsed.format("YYYY-MM-DD HH:mm:ss");
    }
    if (publicData.duration === "lifetime") return parsed.format("YYYY-MM-DD HH:mm:ss");

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
    if (publicData.duration === "lifetime") return "lifetime";

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

/**
 * Refuse purchases that would take paid value away from an active lease.
 * Tier order is the license's own (plans sorted by cheapest license price), nothing hardcoded.
 * - Downgrade (e.g. unlimited -> premium) on an active paid lease: 409 plan_downgrade_not_allowed.
 * - Same or lower plan on an active lifetime lease: 409 lifetime_already_owned.
 * @param {Object} params
 * @param {Object} [params.publicData] current Zelf ID public data
 * @param {string} [params.requestedPlan]
 * @param {string} [params.tagName]
 * @param {Object} [params.domainConfig]
 */
const getPurchaseKeepsPaidValueViolation = ({ publicData = {}, requestedPlan, tagName, domainConfig } = {}) => {
    if (!hasActivePaidLease(publicData)) return null;
    const name = tagName || publicData.tagName || publicData.zelfName;
    const offered = licensePaidPlansForName(name, domainConfig);
    const current = effectivePlan(publicData, domainConfig);
    const target = resolvePaidPlan({ tagName: name, requestedPlan, domainConfig });
    const currentRank = offered.indexOf(current);
    const targetRank = offered.indexOf(target);
    if (currentRank < 0 || targetRank < 0) return null;
    if (targetRank < currentRank) return "409:plan_downgrade_not_allowed";
    if (publicData.duration === "lifetime" && targetRank <= currentRank) return "409:lifetime_already_owned";
    return null;
};

const assertPurchaseKeepsPaidValue = (params = {}) => {
    const violation = getPurchaseKeepsPaidValueViolation(params);
    if (violation) throw new Error(violation);
};

module.exports = {
    assertPurchaseKeepsPaidValue,
    getPurchaseKeepsPaidValueViolation,
    ZELF_ID_RESERVATION_DURATION,
    ZELF_ID_RESERVATION_HOURS,
    getReservationExpiresAt,
    licensePaidPlansForName,
    isPlanOfferedForName,
    isLengthWithinLicense,
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
    assertLicenseOffersPlan,
    resolveZelfIdPlan,
    resolveComplimentaryPlan,
    resolveUpgradePlan,
    effectivePlan,
    isFreeOriginLease,
    planForLimits,
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
