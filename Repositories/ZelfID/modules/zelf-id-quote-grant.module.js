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

/**
 * Insert the pending claim, or report an existing done/pending row.
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
        });
        return { state: "claimed", grant };
    } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        const existing = await QuoteGrant.findOne({ zelfName: name, quoteHash: hash }).lean();
        if (existing && (existing.status === "done" || existing.status == null)) {
            return { state: "done", grant: existing };
        }
        throw inProgress();
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
    claimQuoteGrant,
    completeQuoteGrant,
    quoteHash,
    releaseQuoteGrant,
};
