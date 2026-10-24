/**
 * Idempotent confirm replay. The first request inserts a pending row for this
 * name and quote. A unique index on those two fields makes the claim atomic.
 * Pin timestamps are not used.
 */
const crypto = require("crypto");
const mongoose = require("mongoose");
const QuoteGrant = require("../models/zelf-id-quote-grant.model");
const { normalizeZelfName } = require("../../Tags/modules/zelf-name.util");

const mongoReady = () => mongoose.connection.readyState === 1;

let indexesReady;
const ensureIndexes = () => {
    if (!indexesReady) indexesReady = QuoteGrant.init();
    return indexesReady;
};

const isDuplicateKey = (error) =>
    error?.code === 11000 || error?.cause?.code === 11000 || /must be unique/i.test(String(error?.message || ""));

const quoteHash = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

const normalizedName = (zelfName, domain) => {
    const normalized = normalizeZelfName(zelfName, domain || "zelf");
    return normalized.zelfName || null;
};

const unavailable = () => {
    const error = new Error("503:quote_store_unavailable");
    error.clientCode = "quote_store_unavailable";
    error.clientMessage = "quote_store_unavailable";
    error.status = 503;
    return error;
};

const inProgress = () => {
    const error = new Error("409:in_progress");
    error.clientCode = "in_progress";
    error.clientMessage = "in_progress";
    error.status = 409;
    return error;
};

const requireStore = (token) => {
    if (!mongoReady() || !token) throw unavailable();
};

/** A pending claim older than this can be taken again. */
const PENDING_LEASE_MS = 3 * 60 * 1000;

const leaseExpired = (grant, now = Date.now()) => {
    if (!grant?.claimedAt) return true;
    return new Date(grant.claimedAt).getTime() <= now - PENDING_LEASE_MS;
};

/**
 * A grant whose plan term or coupon redemption already recorded this quote.
 * Used when `status: done` was never written.
 */
const findGrantEvidence = async (zelfName, hash) => {
    const PlanTerm = require("../models/zelf-id-plan-term.model");
    const term = await PlanTerm.findOne({ zelfName, quoteHash: hash }).lean();
    if (term) {
        return {
            plan: term.plan,
            duration: term.duration,
            paymentMethod: term.paymentMethod,
            couponId: term.couponId || null,
            amountPaidUsd: term.amountPaidUsd,
        };
    }

    const Coupon = require("../models/zelf-id-coupon.model");
    const coupon = await Coupon.findOne({ redemptions: { $elemMatch: { zelfId: zelfName, quoteHash: hash } } }).lean();
    if (!coupon) return null;
    const hit = (coupon.redemptions || []).find((redemption) => redemption.zelfId === zelfName && redemption.quoteHash === hash);
    if (!hit) return null;
    return {
        plan: hit.plan,
        duration: hit.duration,
        paymentMethod: "coupon",
        couponId: coupon.id,
        amountPaidUsd: 0,
    };
};

const markDoneFromEvidence = async (existing, evidence) => {
    const $set = { status: "done" };
    if (evidence.plan != null) $set.plan = evidence.plan;
    if (evidence.duration != null) $set.duration = String(evidence.duration);
    if (evidence.paymentMethod != null) $set.paymentMethod = evidence.paymentMethod;
    if (evidence.couponId != null) $set.couponId = evidence.couponId;
    if (typeof evidence.amountPaidUsd === "number") $set.amountPaidUsd = evidence.amountPaidUsd;
    await QuoteGrant.updateOne({ _id: existing._id, status: "pending" }, { $set });
    return { ...existing, ...$set };
};

/**
 * Insert the pending claim, or report an existing done/pending row.
 * A pending row past its lease can be claimed again. If the grant already
 * landed on the plan term or a redemption, the row is marked done instead.
 * @returns {Promise<{ state: "claimed"|"done", grant: Object }>}
 */
const claimQuoteGrant = async ({ zelfName, domain, token, source }) => {
    requireStore(token);
    await ensureIndexes();
    const name = normalizedName(zelfName, domain);
    if (!name) throw unavailable();
    const hash = quoteHash(token);

    try {
        const grant = await QuoteGrant.create({
            zelfName: name,
            quoteHash: hash,
            source: source || "confirm",
            status: "pending",
            claimedAt: new Date(),
        });
        return { state: "claimed", grant };
    } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        const existing = await QuoteGrant.findOne({ zelfName: name, quoteHash: hash }).lean();
        if (!existing) throw inProgress();
        if (existing.status === "done" || existing.status == null) {
            return { state: "done", grant: existing };
        }

        const evidence = await findGrantEvidence(name, hash);
        if (evidence) {
            const grant = await markDoneFromEvidence(existing, evidence);
            return { state: "done", grant };
        }

        if (!leaseExpired(existing)) throw inProgress();

        const reclaimed = await QuoteGrant.findOneAndUpdate(
            {
                _id: existing._id,
                status: "pending",
                $or: [{ claimedAt: { $lte: new Date(Date.now() - PENDING_LEASE_MS) } }, { claimedAt: null }, { claimedAt: { $exists: false } }],
            },
            { $set: { claimedAt: new Date(), source: source || existing.source || "confirm" } },
            { new: true }
        ).lean();
        if (!reclaimed) throw inProgress();
        return { state: "claimed", grant: reclaimed };
    }
};

const completeQuoteGrant = async ({ zelfName, domain, token, source, paymentMethod, couponId, plan, duration, amountPaidUsd }) => {
    requireStore(token);
    const name = normalizedName(zelfName, domain);
    if (!name) throw unavailable();
    const $set = { status: "done" };
    if (source !== undefined) $set.source = source;
    if (paymentMethod !== undefined) $set.paymentMethod = paymentMethod;
    if (couponId !== undefined) $set.couponId = couponId;
    if (plan !== undefined) $set.plan = plan;
    if (duration !== undefined) $set.duration = duration == null ? null : String(duration);
    if (amountPaidUsd !== undefined && amountPaidUsd !== null && Number.isFinite(Number(amountPaidUsd))) {
        $set.amountPaidUsd = Number(amountPaidUsd);
    }

    await QuoteGrant.updateOne({ zelfName: name, quoteHash: quoteHash(token) }, { $set });
};

const releaseQuoteGrant = async ({ zelfName, domain, token }) => {
    if (!mongoReady() || !token) return;
    const name = normalizedName(zelfName, domain);
    if (!name) return;
    await QuoteGrant.deleteOne({ zelfName: name, quoteHash: quoteHash(token), status: "pending" });
};

module.exports = {
    PENDING_LEASE_MS,
    claimQuoteGrant,
    completeQuoteGrant,
    findGrantEvidence,
    quoteHash,
    releaseQuoteGrant,
};
