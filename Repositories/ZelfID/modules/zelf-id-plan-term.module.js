/**
 * Plan term stored beside the pin when `planExpiresAt` or `paymentMethod` would push
 * `extraParams` past the safe Pinata length. Readers merge it onto publicData.
 * The pin keeps `plan`, `expiresAt`, `duration`, and `registeredAt`.
 */
const mongoose = require("mongoose");
const PlanTerm = require("../models/zelf-id-plan-term.model");
const { normalizeZelfName } = require("../../Tags/modules/zelf-name.util");

const mongoReady = () => mongoose.connection.readyState === 1;

const normalizedName = (zelfName, domain) => {
    const normalized = normalizeZelfName(zelfName, domain || "zelf");
    return normalized.zelfName || null;
};

/**
 * @param {Object} params
 * @param {string} params.zelfName bare or full name
 * @param {string} [params.domain]
 * @param {string|null} [params.plan]
 * @param {string|null} [params.planExpiresAt] `YYYY-MM-DD HH:mm:ss` UTC
 * @param {string|null} [params.paymentMethod]
 * @param {number|null} [params.amountPaidUsd] USD actually charged for this term
 */
const savePlanTerm = async ({ zelfName, domain, plan, planExpiresAt, paymentMethod, duration, amountPaidUsd, quoteHash }) => {
    if (!mongoReady()) return null;
    const name = normalizedName(zelfName, domain);
    if (!name) return null;

    const $set = { zelfName: name };
    if (plan !== undefined) $set.plan = plan;
    if (planExpiresAt !== undefined) $set.planExpiresAt = planExpiresAt;
    if (paymentMethod !== undefined) $set.paymentMethod = paymentMethod;
    if (duration !== undefined) $set.duration = duration;
    if (amountPaidUsd !== undefined) $set.amountPaidUsd = amountPaidUsd;
    if (quoteHash !== undefined) $set.quoteHash = quoteHash;
    if (Object.keys($set).length === 1) return null;

    return PlanTerm.findOneAndUpdate({ zelfName: name }, { $set }, { upsert: true, new: true });
};

const deletePlanTerm = async (zelfName, domain) => {
    if (!mongoReady()) return;
    const name = normalizedName(zelfName, domain);
    if (!name) return;
    await PlanTerm.deleteOne({ zelfName: name });
};

/**
 * Fill `planExpiresAt` and `paymentMethod` when the pin left them out.
 * Does not replace a plan already stored on the pin.
 * @param {Object} publicData
 * @returns {Promise<Object>}
 */
const mergePlanTermIntoPublicData = async (publicData) => {
    if (!publicData || !mongoReady()) return publicData;
    const rawName = publicData.tagName || publicData.zelfName;
    if (!rawName) return publicData;
    const name = normalizedName(rawName, publicData.domain || "zelf");
    if (!name) return publicData;

    const row = await PlanTerm.findOne({ zelfName: name }).lean();
    if (!row) return publicData;
    if (!publicData.planExpiresAt && row.planExpiresAt) publicData.planExpiresAt = row.planExpiresAt;
    if (!publicData.paymentMethod && row.paymentMethod) publicData.paymentMethod = row.paymentMethod;
    if (!publicData.plan && row.plan) publicData.plan = row.plan;
    if (!publicData.planDuration && row.duration) publicData.planDuration = row.duration;
    return publicData;
};

/**
 * Merge the Mongo plan term onto a search result. Tags search, Zelf ID search,
 * my-plan, sync, and Zelf Keys `/limits` (`loadTagPublicData` → Tags `searchTag`) use this.
 * @param {Object} result
 * @returns {Promise<Object>}
 */
const readLeaseSearchResult = async (result) => {
    if (result?.tagObject?.publicData) await mergePlanTermIntoPublicData(result.tagObject.publicData);
    if (Array.isArray(result?.ipfs)) {
        for (const row of result.ipfs) {
            if (row?.publicData) await mergePlanTermIntoPublicData(row.publicData);
        }
    }
    return result;
};

module.exports = {
    deletePlanTerm,
    mergePlanTermIntoPublicData,
    readLeaseSearchResult,
    savePlanTerm,
};
