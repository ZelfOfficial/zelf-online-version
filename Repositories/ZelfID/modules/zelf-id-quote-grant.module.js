/**
 * Idempotent confirm replay. The key is the normalized Zelf ID plus a hash of the
 * signed quote (or the Stripe Checkout session id). Pin timestamps are not used.
 */
const crypto = require("crypto");
const mongoose = require("mongoose");
const QuoteGrant = require("../models/zelf-id-quote-grant.model");
const { normalizeZelfName } = require("../../Tags/modules/zelf-name.util");

const mongoReady = () => mongoose.connection.readyState === 1;

const quoteHash = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

const normalizedName = (zelfName, domain) => {
    const normalized = normalizeZelfName(zelfName, domain || "zelf");
    return normalized.zelfName || null;
};

const findQuoteGrant = async ({ zelfName, domain, token }) => {
    if (!mongoReady() || !token) return null;
    const name = normalizedName(zelfName, domain);
    if (!name) return null;
    return QuoteGrant.findOne({ zelfName: name, quoteHash: quoteHash(token) }).lean();
};

const saveQuoteGrant = async ({ zelfName, domain, token, source, paymentMethod, couponId, plan, duration }) => {
    if (!mongoReady() || !token) return null;
    const name = normalizedName(zelfName, domain);
    if (!name) return null;

    return QuoteGrant.findOneAndUpdate(
        { zelfName: name, quoteHash: quoteHash(token) },
        {
            $setOnInsert: {
                zelfName: name,
                quoteHash: quoteHash(token),
                source: source || "confirm",
                paymentMethod: paymentMethod || null,
                couponId: couponId || null,
                plan: plan || null,
                duration: duration == null ? null : String(duration),
            },
        },
        { upsert: true, new: true }
    );
};

module.exports = {
    findQuoteGrant,
    quoteHash,
    saveQuoteGrant,
};
