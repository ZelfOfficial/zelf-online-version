/**
 * Atomic claim on a RevenueCat event.id (unique index), so an event is credited once.
 */
const loadModel = () => require("../models/revenue-cat-processed-event.model");

/** A `processing` claim older than this is treated as abandoned (process crashed mid-credit). */
const STALE_CLAIM_MS = Number(process.env.REVENUECAT_EVENT_CLAIM_STALE_MS) || 10 * 60 * 1000;

const CREDITED_ACTIONS = ["zelf_id_lease_extended", "already_extended"];

const isDuplicateKeyError = (error) => error?.code === 11000 || error?.code === 11001 || /E11000/.test(String(error?.message || ""));

/**
 * @param {{ eventId: string, eventType?: string, originalTransactionId?: string, productId?: string }} event
 * @returns {Promise<boolean>} true when this caller owns the event and may credit it
 */
const claimEvent = async ({ eventId, eventType = "", transactionId = "", originalTransactionId = "", productId = "" }) => {
    const Model = loadModel();
    try {
        await Model.create({ eventId, eventType, transactionId, originalTransactionId, productId, status: "processing", claimedAt: new Date() });
        return true;
    } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
    }

    // Take over only an abandoned claim; a processed or in-flight event stays owned by its first caller.
    const takenOver = await Model.findOneAndUpdate(
        { eventId, status: "processing", claimedAt: { $lt: new Date(Date.now() - STALE_CLAIM_MS) } },
        { $set: { claimedAt: new Date() } },
        { new: true }
    ).lean();

    return Boolean(takenOver);
};

/** Crediting failed: drop the claim so RevenueCat's retry can credit it. */
const releaseEvent = async (eventId) => {
    await loadModel().deleteOne({ eventId, status: "processing" });
};

const markEventProcessed = async (eventId, result) => {
    await loadModel().updateOne({ eventId }, { $set: { status: "processed", processedAt: new Date(), result: result ?? null } });
};

/**
 * Another event already credited this store transaction (same purchase delivered under a different event.id).
 * @returns {Promise<Object|null>}
 */
const findCreditedTransaction = async ({ transactionId, eventId }) => {
    if (!transactionId) return null;
    return loadModel()
        .findOne({ transactionId, eventId: { $ne: eventId }, status: "processed", "result.action": { $in: CREDITED_ACTIONS } })
        .lean();
};

/** Build the unique index at startup (do not rely on mongoose autoIndex). */
const ensureIndexes = async () => loadModel().createIndexes();

module.exports = { claimEvent, findCreditedTransaction, releaseEvent, markEventProcessed, ensureIndexes, isDuplicateKeyError, STALE_CLAIM_MS };
