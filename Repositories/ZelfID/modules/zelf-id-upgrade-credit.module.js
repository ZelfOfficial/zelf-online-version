/**
 * Premium → Unlimited mid-term credit.
 * credit = amount paid for the open Premium term × remaining / total seconds,
 * floored to the cent and capped at the Unlimited price.
 * Total is planExpiresAt minus termStartedAt when that start is stored,
 * otherwise planExpiresAt minus the duration.
 * Lifetime and lapsed terms credit nothing. A missing payment record credits 0.
 */
const moment = require("moment");
const mongoose = require("mongoose");
const { parseLeaseDate } = require("../../Tags/modules/lease-date.util");
const { effectivePlan, isExpiresAtPassed, normalizePaymentDuration } = require("./zelf-id-plan.module");
const { normalizeZelfName } = require("../../Tags/modules/zelf-name.util");
const PlanTerm = require("../models/zelf-id-plan-term.model");

const mongoReady = () => mongoose.connection.readyState === 1;

const floorCents = (usd) => {
    const n = Number(usd);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.floor(n * 100 + 1e-9) / 100;
};

const roundCents = (usd) => {
    const n = Number(usd);
    if (!Number.isFinite(n)) return 0;
    return Math.max(Math.round(n * 100) / 100, 0);
};

const creditFromPaid = ({ amountPaidUsd, planExpiresAt, duration, termStartedAt, listPriceUsd, now = moment.utc() }) => {
    const normalized = normalizePaymentDuration(duration);
    if (normalized === "lifetime") return 0;
    if (!planExpiresAt || isExpiresAtPassed({ expiresAt: planExpiresAt })) return 0;

    const paid = Number(amountPaidUsd);
    if (!Number.isFinite(paid) || paid <= 0) return 0;

    const end = parseLeaseDate(planExpiresAt);
    if (!end.isValid()) return 0;
    const storedStart = termStartedAt ? moment.utc(termStartedAt) : null;
    let start = storedStart && storedStart.isValid() && end.isAfter(storedStart) ? storedStart : null;
    if (!start) {
        const years = Number(normalized);
        if (!Number.isFinite(years) || years <= 0) return 0;
        start = end.clone().subtract(years, "year");
    }
    const total = end.diff(start, "seconds");
    const remaining = end.diff(now, "seconds");
    if (!(total > 0) || remaining <= 0) return 0;

    const raw = (paid * remaining) / total;
    const capped = Math.min(floorCents(raw), roundCents(listPriceUsd));
    return capped;
};

const priceAfterUpgradeCredit = (listPriceUsd, upgradeCreditUsd) => {
    const list = roundCents(listPriceUsd);
    const credit = roundCents(upgradeCreditUsd);
    return roundCents(Math.max(list - credit, 0));
};

/**
 * Same-plan renewal of an open term adds the new charge onto what this term already recorded.
 * A plan change stores only the new charge. A lapsed term is closed, so its amount is not carried forward.
 */
const combineAmountPaid = ({ previousPlan, previousAmount, nextPlan, charged, previousTermLapsed = false }) => {
    const next = roundCents(charged);
    if (previousTermLapsed) return next;
    const same = previousPlan && String(previousPlan).toLowerCase() === String(nextPlan || "").toLowerCase();
    if (same && typeof previousAmount === "number") return roundCents(previousAmount + Number(charged));
    return next;
};

const amountPaidForTerm = async ({ zelfName, domain, publicData = {} }) => {
    const normalized = normalizeZelfName(zelfName, domain || publicData.domain || "zelf");
    const name = normalized.zelfName;
    if (!name) return { amountPaidUsd: 0, known: false };
    if (!mongoReady()) {
        console.info("[zelf-id-upgrade-credit] amount_paid_unknown", { zelfName: name });
        return { amountPaidUsd: 0, known: false };
    }

    const term = await PlanTerm.findOne({ zelfName: name }).lean();
    if (term && typeof term.amountPaidUsd === "number") {
        return { amountPaidUsd: term.amountPaidUsd, known: true, term };
    }

    const paymentMethod = term?.paymentMethod || publicData.paymentMethod;
    if (paymentMethod === "whitelist") return { amountPaidUsd: 0, known: true, term };

    const QuoteGrant = require("../models/zelf-id-quote-grant.model");
    const grant = await QuoteGrant.findOne({ zelfName: name, status: "done", amountPaidUsd: { $type: "number" } })
        .sort({ updatedAt: -1 })
        .lean();
    if (grant) return { amountPaidUsd: grant.amountPaidUsd, known: true, term };

    if (paymentMethod === "coupon" || term?.paymentMethod === "coupon") {
        const Coupon = require("../models/zelf-id-coupon.model");
        const coupon = await Coupon.findOne({ "redemptions.zelfId": name, percentOff: 100 }).lean();
        if (coupon) return { amountPaidUsd: 0, known: true, term };
    }

    console.info("[zelf-id-upgrade-credit] amount_paid_unknown", { zelfName: name });
    return { amountPaidUsd: 0, known: false, term };
};

/**
 * @returns {Promise<{ upgradeCreditUsd: number, amountPaidUsd: number, listPriceUsd: number }>}
 */
const computeUpgradeCredit = async ({ publicData = {}, tagName, domain, targetPlan, listPriceUsd }) => {
    const list = roundCents(listPriceUsd);
    const none = { upgradeCreditUsd: 0, amountPaidUsd: 0, listPriceUsd: list };
    if (String(targetPlan || "").toLowerCase() !== "unlimited") return none;
    if (effectivePlan(publicData) !== "premium") return none;

    const name = tagName || publicData.tagName || publicData.zelfName;
    const paid = await amountPaidForTerm({ zelfName: name, domain, publicData });
    const term = paid.term;
    let duration = term?.duration || publicData.planDuration;
    let planExpiresAt = term?.planExpiresAt || publicData.planExpiresAt;
    // A name paid from the start has no planExpiresAt; the name lease is the Premium term.
    // Ignore a 100-year Free lease, and ignore an expiry that is not inside this duration.
    if (!planExpiresAt && publicData.expiresAt) {
        const leaseDuration = normalizePaymentDuration(duration || publicData.duration);
        const years = Number(leaseDuration);
        if (leaseDuration !== "lifetime" && years > 0 && years < 100) {
            const end = parseLeaseDate(publicData.expiresAt);
            const start = end.clone().subtract(years, "year");
            const now = moment.utc();
            if (end.isValid() && now.isSameOrAfter(start) && end.isAfter(now)) {
                planExpiresAt = publicData.expiresAt;
                duration = leaseDuration;
            }
        }
    }
    const upgradeTerm = {
        id: term?._id ? String(term._id) : null,
        planExpiresAt: planExpiresAt || null,
        amountPaidUsd: paid.amountPaidUsd,
        duration: duration ? String(duration) : null,
        termStartedAt: termStartedAtStamp(term?.termStartedAt) || null,
    };
    if (!duration || normalizePaymentDuration(duration) === "lifetime" || !planExpiresAt) {
        return { ...none, amountPaidUsd: paid.amountPaidUsd, upgradeTerm };
    }

    const upgradeCreditUsd = creditFromPaid({
        amountPaidUsd: paid.amountPaidUsd,
        planExpiresAt,
        duration,
        termStartedAt: term?.termStartedAt,
        listPriceUsd: list,
    });
    return { upgradeCreditUsd, amountPaidUsd: paid.amountPaidUsd, listPriceUsd: list, upgradeTerm };
};

/**
 * ISO instant, or "" when the term has no stored start.
 * Both sides empty match, the same way a missing planExpiresAt matches.
 * One side set and the other empty does not.
 */
const termStartedAtStamp = (value) => {
    if (value == null || value === "") return "";
    const parsed = moment.utc(value);
    return parsed.isValid() ? parsed.toISOString() : "";
};

const sameUpgradeTerm = (signed = {}, current = {}) => {
    const signedPaid = signed.amountPaidUsd == null ? null : Number(signed.amountPaidUsd);
    const currentPaid = current.amountPaidUsd == null ? null : Number(current.amountPaidUsd);
    const paidMatches = signedPaid == null || currentPaid == null || Math.abs(signedPaid - currentPaid) < 0.001;
    return (
        String(signed.id || "") === String(current.id || "") &&
        String(signed.planExpiresAt || "") === String(current.planExpiresAt || "") &&
        String(signed.duration || "") === String(current.duration || "") &&
        paidMatches &&
        termStartedAtStamp(signed.termStartedAt) === termStartedAtStamp(current.termStartedAt)
    );
};

const lockedCreditUsd = (tokenDecoded = {}) => {
    if (tokenDecoded.upgradeCreditUsd == null || tokenDecoded.upgradeCreditUsd === "") return 0;
    const locked = Number(tokenDecoded.upgradeCreditUsd);
    return Number.isFinite(locked) ? locked : 0;
};

const termWasQuoted = (term) => Boolean(term && (term.id || term.planExpiresAt || term.duration || term.amountPaidUsd != null));

/**
 * The signed quote locks the credit for its TTL, the same way it locks a crypto price.
 * Confirm does not recompute that credit from the clock. It rejects when the plan term
 * the credit was based on is no longer the current term, including termStartedAt.
 */
const assertQuoteUpgradeTerm = async ({ tokenDecoded = {}, publicData, tagName, domain, domainConfig, targetPlan }) => {
    const locked = lockedCreditUsd(tokenDecoded);
    const signedTerm = tokenDecoded.upgradeTerm || null;
    if (!termWasQuoted(signedTerm)) {
        return { upgradeCreditUsd: locked, upgradeTerm: signedTerm };
    }
    const { getZelfIdCheckoutPrice } = require("./zelf-id-plan.module");
    const priced = getZelfIdCheckoutPrice({
        tagName: tagName || tokenDecoded.tagName,
        duration: tokenDecoded.duration || "1",
        referralTagName: "",
        domainConfig,
        requestedPlan: targetPlan || tokenDecoded.plan,
    });
    const fresh = await computeUpgradeCredit({
        publicData,
        tagName: tagName || tokenDecoded.tagName,
        domain,
        targetPlan: targetPlan || tokenDecoded.plan,
        listPriceUsd: priced.priceWithoutDiscount ?? priced.price,
    });
    if (!fresh.upgradeTerm || !sameUpgradeTerm(signedTerm, fresh.upgradeTerm)) {
        const error = new Error("409:upgrade_term_changed");
        error.clientCode = "upgrade_term_changed";
        error.clientMessage = "upgrade_term_changed";
        error.status = 409;
        throw error;
    }
    return { upgradeCreditUsd: locked, upgradeTerm: signedTerm };
};

const assertSignedUpgradeCredit = async ({ tokenDecoded = {}, publicData, tagName, domain, domainConfig, targetPlan }) => {
    const { getZelfIdCheckoutPrice } = require("./zelf-id-plan.module");
    const priced = getZelfIdCheckoutPrice({
        tagName: tagName || tokenDecoded.tagName,
        duration: tokenDecoded.duration || "1",
        referralTagName: "",
        domainConfig,
        requestedPlan: targetPlan || tokenDecoded.plan,
    });
    const fresh = await computeUpgradeCredit({
        publicData,
        tagName: tagName || tokenDecoded.tagName,
        domain,
        targetPlan: targetPlan || tokenDecoded.plan,
        listPriceUsd: priced.priceWithoutDiscount ?? priced.price,
    });
    const signed = tokenDecoded.upgradeCreditUsd;
    if (signed == null && fresh.upgradeCreditUsd === 0) return fresh;
    if (Math.abs(Number(signed || 0) - fresh.upgradeCreditUsd) > 0.009) {
        const error = new Error("409:upgrade_credit_changed");
        error.clientCode = "upgrade_credit_changed";
        error.clientMessage = "upgrade_credit_changed";
        error.status = 409;
        throw error;
    }
    return fresh;
};

module.exports = {
    amountPaidForTerm,
    assertSignedUpgradeCredit,
    combineAmountPaid,
    computeUpgradeCredit,
    creditFromPaid,
    floorCents,
    priceAfterUpgradeCredit,
    assertQuoteUpgradeTerm,
    sameUpgradeTerm,
};
