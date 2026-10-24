/**
 * Percent-off coupons for Zelf ID Premium and Unlimited.
 * List price is the license planPricing quote (`getZelfIdCheckoutPrice` / `priceWithoutDiscount`).
 * A redemption is a conditional update so concurrent confirms cannot pass maxRedemptions
 * or the per-Zelf-ID limit.
 */
const crypto = require("crypto");
const Coupon = require("../models/zelf-id-coupon.model");
const { getZelfIdCheckoutPrice, normalizePaymentDuration } = require("./zelf-id-plan.module");

const PLAN_RULE_CODES = {
    plan_downgrade_not_allowed: "downgrade_not_allowed",
    plan_not_offered_for_name: "plan_not_allowed_for_name",
    plan_not_allowed_for_name: "plan_not_allowed_for_name",
    lifetime_already_owned: "lifetime_already_owned",
};

const httpError = (status, message, code = message) => {
    const err = new Error(`${status}:${message}`);
    err.clientCode = code;
    err.clientMessage = message;
    return err;
};

const couponInvalid = (reason) => httpError(409, "coupon_invalid", reason || "coupon_invalid");

const mapPlanRuleError = (error) => {
    const raw = String(error?.message || "");
    const detail = raw.includes(":") ? raw.split(":").slice(1).join(":") : raw;
    const mapped = PLAN_RULE_CODES[detail];
    if (!mapped) return error;
    return httpError(409, mapped, mapped);
};

const normalizeCode = (code) =>
    String(code || "")
        .trim()
        .toUpperCase();

const normalizeZelfId = (zelfId) => String(zelfId || "").trim().toLowerCase();

/**
 * Quote duration (`"1"` … `"5"`, `"lifetime"`, `999`) → redemption token (`1y` … `5y`, `lifetime`).
 * @param {string|number} duration
 * @returns {string}
 */
const durationToken = (duration) => {
    const normalized = normalizePaymentDuration(duration);
    if (normalized === "lifetime") return "lifetime";
    return `${normalized}y`;
};

/**
 * `amountDue = listPrice × (100 − percentOff) / 100`, rounded to the nearest cent.
 * @param {number} listPrice
 * @param {number} percentOff
 * @returns {number}
 */
const amountDueFor = (listPrice, percentOff) => {
    const listCents = Math.round(Number(listPrice) * 100);
    if (!Number.isFinite(listCents)) return 0;
    const dueCents = Math.round((listCents * (100 - Number(percentOff))) / 100);
    return Math.max(dueCents, 0) / 100;
};

const toPublic = (doc) => {
    const row = doc && typeof doc.toObject === "function" ? doc.toObject() : doc || {};
    const coupon = {
        id: row.id,
        code: row.code,
        percentOff: row.percentOff,
        plans: row.plans || [],
    };
    if (Array.isArray(row.durations) && row.durations.length) coupon.durations = row.durations;
    coupon.maxRedemptions = row.maxRedemptions;
    coupon.perZelfIdLimit = row.perZelfIdLimit ?? 1;
    if (row.expiresAt) coupon.expiresAt = new Date(row.expiresAt).toISOString();
    coupon.active = row.active !== false;
    coupon.createdBy = row.createdBy;
    coupon.redemptions = (row.redemptions || []).map((redemption) => ({
        zelfId: redemption.zelfId,
        plan: redemption.plan,
        duration: redemption.duration,
        redeemedAt: new Date(redemption.redeemedAt).toISOString(),
    }));
    return coupon;
};

/**
 * Rejection checks, in the documented order. Null means the coupon can be quoted.
 * @returns {string|null}
 */
const rejectionReason = (coupon, { plan, duration, zelfId, now = new Date() } = {}) => {
    if (!coupon) return "not_found";
    if (coupon.active === false) return "inactive";
    if (coupon.expiresAt && new Date(coupon.expiresAt).getTime() <= now.getTime()) return "expired";
    const redemptions = coupon.redemptions || [];
    if (redemptions.length >= Number(coupon.maxRedemptions)) return "max_redemptions";
    const plans = (coupon.plans || []).map((entry) => String(entry).toLowerCase());
    if (!plans.includes(String(plan || "").toLowerCase())) return "plan_not_allowed";
    const token = durationToken(duration);
    const allowed = coupon.durations || [];
    if (allowed.length && !allowed.includes(token)) return "duration_not_allowed";
    const zelfKey = normalizeZelfId(zelfId);
    const usedByZelfId = redemptions.filter((redemption) => normalizeZelfId(redemption.zelfId) === zelfKey).length;
    const limit = Number(coupon.perZelfIdLimit ?? 1);
    if (usedByZelfId >= limit) return "zelf_id_limit";
    return null;
};

const describeDoc = (coupon, { code, plan, duration, zelfId, listPrice }) => {
    const normalized = normalizeCode(code) || (coupon ? coupon.code : "");
    const reason = rejectionReason(coupon, { plan, duration, zelfId });
    const price = Number(listPrice);
    const list = Number.isFinite(price) ? price : 0;
    if (reason) {
        return {
            valid: false,
            reason,
            listPrice: list,
            percentOff: 0,
            amountDue: list,
            currency: "USD",
            durationToken: durationToken(duration),
            coupon: { code: normalized, valid: false, reason },
        };
    }
    const percentOff = Number(coupon.percentOff);
    const amountDue = amountDueFor(list, percentOff);
    return {
        valid: true,
        listPrice: list,
        percentOff,
        amountDue,
        currency: "USD",
        durationToken: durationToken(duration),
        coupon: { id: coupon.id, code: coupon.code, valid: true },
    };
};

const describeCoupon = async ({ code, plan, duration, zelfId, listPrice }) => {
    const normalized = normalizeCode(code);
    const coupon = normalized ? await Coupon.findOne({ code: normalized }).lean() : null;
    return describeDoc(coupon, { code: normalized || code, plan, duration, zelfId, listPrice });
};

/**
 * License list price for this name, plan and duration (planPricing only; no referral discount).
 * @returns {number}
 */
const licenseListPrice = ({ tagName, duration, domainConfig, plan }) => {
    const quote = getZelfIdCheckoutPrice({
        tagName,
        duration: normalizePaymentDuration(duration),
        referralTagName: "",
        domainConfig,
        requestedPlan: plan,
    });
    return Number(quote.priceWithoutDiscount);
};

const priceCoupon = async ({ code, plan, duration, zelfId, tagName, domainConfig }) => {
    const listPrice = licenseListPrice({ tagName: tagName || zelfId, duration, domainConfig, plan });
    return describeCoupon({ code, plan, duration, zelfId, listPrice });
};

const createCoupon = async (input = {}, createdBy) => {
    const code = normalizeCode(input.code);
    if (!code) throw httpError(409, "coupon_code_taken", "coupon_code_taken");
    const percentOff = Number(input.percentOff);
    if (!Number.isInteger(percentOff) || percentOff < 1 || percentOff > 100) {
        throw httpError(409, '"percentOff" must be between 1 and 100', "validation_error");
    }
    const plans = [...new Set((input.plans || []).map((plan) => String(plan).toLowerCase()))];
    if (!plans.length || plans.some((plan) => plan !== "premium" && plan !== "unlimited")) {
        throw httpError(409, "plans must be premium and/or unlimited", "validation_error");
    }
    const durations = [...new Set((input.durations || []).map((duration) => String(duration).toLowerCase()))];
    const allowedDurations = new Set(["1y", "2y", "3y", "lifetime"]);
    if (durations.some((duration) => !allowedDurations.has(duration))) {
        throw httpError(409, "durations must be 1y, 2y, 3y, or lifetime", "validation_error");
    }
    const maxRedemptions = Number(input.maxRedemptions);
    if (!Number.isInteger(maxRedemptions) || maxRedemptions < 1) {
        throw httpError(409, "maxRedemptions must be at least 1", "validation_error");
    }
    const perZelfIdLimit = input.perZelfIdLimit == null ? 1 : Number(input.perZelfIdLimit);
    if (!Number.isInteger(perZelfIdLimit) || perZelfIdLimit < 1) {
        throw httpError(409, "perZelfIdLimit must be at least 1", "validation_error");
    }
    let expiresAt = null;
    if (input.expiresAt) {
        expiresAt = new Date(input.expiresAt);
        if (Number.isNaN(expiresAt.getTime())) throw httpError(409, "expiresAt must be an ISO-8601 time", "validation_error");
    }
    const author = String(createdBy || "").trim();
    if (!author) throw httpError(409, "createdBy is required", "validation_error");

    const existing = await Coupon.findOne({ code }).select("id").lean();
    if (existing) throw httpError(409, "coupon_code_taken", "coupon_code_taken");

    const coupon = new Coupon({
        id: crypto.randomUUID(),
        code,
        percentOff,
        plans,
        durations,
        maxRedemptions,
        perZelfIdLimit,
        expiresAt,
        active: true,
        createdBy: author,
        redemptions: [],
    });

    try {
        await coupon.save();
    } catch (error) {
        if (error && error.code === 11000) throw httpError(409, "coupon_code_taken", "coupon_code_taken");
        throw error;
    }

    console.info("[zelf-id-coupon] created", {
        id: coupon.id,
        code: coupon.code,
        percentOff: coupon.percentOff,
        plans: coupon.plans,
        createdBy: coupon.createdBy,
    });

    return toPublic(coupon);
};

const listCoupons = async () => {
    const coupons = await Coupon.find({}).sort({ createdAt: -1 });
    return coupons.map(toPublic);
};

const deactivateCoupon = async (id) => {
    const coupon = await Coupon.findOneAndUpdate({ id: String(id || "").trim() }, { $set: { active: false } }, { new: true });
    if (!coupon) throw httpError(404, "coupon_not_found", "coupon_not_found");
    return toPublic(coupon);
};

const claimRedemption = async (coupon, { zelfId, plan, duration }) => {
    const key = crypto.randomUUID();
    const redeemedAt = new Date();
    const updated = await Coupon.findOneAndUpdate(
        {
            id: coupon.id,
            active: true,
            $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }],
            $expr: {
                $and: [
                    { $lt: [{ $size: { $ifNull: ["$redemptions", []] } }, "$maxRedemptions"] },
                    {
                        $lt: [
                            {
                                $size: {
                                    $filter: {
                                        input: { $ifNull: ["$redemptions", []] },
                                        as: "redemption",
                                        cond: { $eq: ["$$redemption.zelfId", zelfId] },
                                    },
                                },
                            },
                            { $ifNull: ["$perZelfIdLimit", 1] },
                        ],
                    },
                ],
            },
        },
        {
            $push: {
                redemptions: { zelfId, plan, duration, redeemedAt, key },
            },
        },
        { new: true }
    );
    if (!updated) return null;
    return { coupon: updated, key, redeemedAt };
};

/**
 * Recompute the coupon from the license and record one redemption if the caps still hold.
 * Does not trust a client total: `signedAmount`, when passed, must match the recomputed amount.
 * @returns {Promise<{ couponId: string, code: string, amountDue: number, percentOff: number, listPrice: number, redemptionKey: string }>}
 */
const claimForGrant = async ({ code, couponId, zelfId, plan, duration, domainConfig, tagName, signedAmount, requireZero = false, listPrice }) => {
    let resolvedCode = normalizeCode(code);
    if (!resolvedCode && couponId) {
        const byId = await Coupon.findOne({ id: String(couponId) }).select("code").lean();
        resolvedCode = byId ? byId.code : "";
    }
    const price = listPrice != null ? Number(listPrice) : licenseListPrice({ tagName: tagName || zelfId, duration, domainConfig, plan });
    const described = await describeCoupon({ code: resolvedCode, plan, duration, zelfId, listPrice: price });
    if (!described.valid) throw couponInvalid(described.reason);
    if (requireZero && described.amountDue !== 0) throw new Error("409:checkout_total_not_zero");
    if (signedAmount != null && Math.abs(Number(signedAmount) - described.amountDue) > 0.009) {
        throw httpError(409, "Quoted total no longer matches the license price", "quote_price_changed");
    }

    const coupon = await Coupon.findOne({ code: resolvedCode });
    const zelfKey = normalizeZelfId(zelfId);
    const claimed = coupon
        ? await claimRedemption(coupon, { zelfId: zelfKey, plan: String(plan).toLowerCase(), duration: described.durationToken })
        : null;
    if (!claimed) {
        const again = await describeCoupon({ code: resolvedCode, plan, duration, zelfId: zelfKey, listPrice: price });
        throw couponInvalid(again.reason || "max_redemptions");
    }

    console.info("[zelf-id-coupon] redeemed", {
        id: claimed.coupon.id,
        code: claimed.coupon.code,
        zelfId: zelfKey,
        plan: String(plan).toLowerCase(),
        duration: described.durationToken,
    });

    return {
        couponId: claimed.coupon.id,
        code: claimed.coupon.code,
        amountDue: described.amountDue,
        percentOff: described.percentOff,
        listPrice: described.listPrice,
        redemptionKey: claimed.key,
        durationToken: described.durationToken,
    };
};

/**
 * Redemption of this coupon for this Zelf ID that happened after the signed quote.
 * Replaying that same confirm returns the grant instead of consuming another redemption.
 * A later quote (initiatedAt after the redemption) is not a replay.
 * @returns {Promise<{ couponId: string, code: string, plan: string, duration: string }|null>}
 */
const findGrantForReplay = async ({ code, zelfId, initiatedAt }) => {
    const started = Number(initiatedAt);
    if (!Number.isFinite(started)) return null;
    const coupon = await Coupon.findOne({ code: normalizeCode(code) }).lean();
    if (!coupon) return null;
    const zelfKey = normalizeZelfId(zelfId);
    const hit = (coupon.redemptions || []).find((redemption) => {
        if (normalizeZelfId(redemption.zelfId) !== zelfKey) return false;
        return new Date(redemption.redeemedAt).getTime() > started * 1000;
    });
    if (!hit) return null;
    return { couponId: coupon.id, code: coupon.code, plan: hit.plan, duration: hit.duration };
};

const releaseRedemption = async ({ couponId, redemptionKey }) => {
    if (!couponId || !redemptionKey) return;
    await Coupon.updateOne({ id: couponId }, { $pull: { redemptions: { key: redemptionKey } } });
};

const assertCouponPlanRules = ({ publicData, requestedPlan, tagName, domainConfig, duration }) => {
    const { assertPurchaseKeepsPaidValue, assertLicenseOffersPlan } = require("./zelf-id-plan.module");
    try {
        assertLicenseOffersPlan({ domainConfig, tagName, plan: requestedPlan, duration });
        assertPurchaseKeepsPaidValue({ publicData, requestedPlan, tagName, domainConfig });
    } catch (error) {
        throw mapPlanRuleError(error);
    }
};

module.exports = {
    amountDueFor,
    assertCouponPlanRules,
    claimForGrant,
    couponInvalid,
    findGrantForReplay,
    createCoupon,
    deactivateCoupon,
    describeCoupon,
    durationToken,
    httpError,
    licenseListPrice,
    listCoupons,
    mapPlanRuleError,
    normalizeCode,
    priceCoupon,
    rejectionReason,
    releaseRedemption,
    toPublic,
};
