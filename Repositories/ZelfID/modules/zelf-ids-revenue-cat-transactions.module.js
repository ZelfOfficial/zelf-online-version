/**
 * Lookup store for RevenueCat original_transaction_id → Zelf ID.
 */
const loadModel = () => require("../models/revenue-cat-zelf-id-transaction.model");

/**
 * @param {string} originalTransactionId
 * @returns {Promise<Object|null>}
 */
const findByOriginalTransactionId = async (originalTransactionId) => {
    const id = String(originalTransactionId || "").trim();
    if (!id) return null;
    return loadModel().findOne({ originalTransactionId: id }).lean();
};

/**
 * Upsert the mapping after an applied event.
 * @param {Object} record
 * @returns {Promise<void>}
 */
const recordTransaction = async (record = {}) => {
    const id = String(record.originalTransactionId || "").trim();
    if (!id || !record.tagName) return;

    const set = { tagName: record.tagName, domain: record.domain || "zelf" };
    for (const key of ["ethAddress", "appUserId", "productId", "plan", "environment", "lastEventId", "lastEventType", "status"]) {
        if (record[key] !== undefined && record[key] !== null) set[key] = String(record[key]);
    }
    if (record.subscription !== undefined) set.subscription = Boolean(record.subscription);

    await loadModel().updateOne({ originalTransactionId: id }, { $set: set }, { upsert: true });
};

module.exports = { findByOriginalTransactionId, recordTransaction };
