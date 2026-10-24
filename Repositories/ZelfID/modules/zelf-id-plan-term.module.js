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
 */
const savePlanTerm = async ({ zelfName, domain, plan, planExpiresAt, paymentMethod }) => {
    if (!mongoReady()) return null;
    const name = normalizedName(zelfName, domain);
    if (!name) return null;
    if (!planExpiresAt && !paymentMethod) return null;

    return PlanTerm.findOneAndUpdate(
        { zelfName: name },
        {
            $set: {
                zelfName: name,
                plan: plan || null,
                planExpiresAt: planExpiresAt || null,
                paymentMethod: paymentMethod || null,
            },
        },
        { upsert: true, new: true }
    );
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
    return publicData;
};

module.exports = {
    deletePlanTerm,
    mergePlanTermIntoPublicData,
    savePlanTerm,
};
