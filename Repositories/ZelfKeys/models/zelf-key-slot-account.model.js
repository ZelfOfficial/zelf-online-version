const mongoose = require("mongoose");

const Schema = mongoose.Schema;
const { addBasicPlugins } = require("../../../Core/mongoose-utils");

/**
 * One extra vault slot bought with ZNS. Expired rows stay so existing items are never deleted.
 */
const slotSchema = new Schema(
    {
        slotId: { type: String, required: true },
        kind: { type: String, enum: ["password", "zotp"], required: true },
        purchasedAt: { type: Date, required: true },
        expiresAt: { type: Date, required: true },
        tokenCost: { type: Number, required: true },
        idempotencyKey: { type: String, required: true },
    },
    { _id: false },
);

const purchaseSchema = new Schema(
    {
        idempotencyKey: { type: String, required: true },
        kind: { type: String, enum: ["password", "zotp"], required: true },
        tokenCost: { type: Number, required: true },
        slotId: { type: String, required: true },
        purchasedAt: { type: Date, required: true },
    },
    { _id: false },
);

/**
 * Token holds and extra slots for one Zelf identity (`tag.domain`).
 * `spent` is the ZNS already reserved for slots. Spendable balance is the on-chain
 * ZNS balance minus `spent`. The document is updated with a single conditional write
 * so two purchases cannot drive `spent` past the observed balance.
 */
const zelfKeySlotAccountSchema = new Schema({
    zelfName: { type: String, required: true, unique: true },
    domain: { type: String, required: true },
    tagName: { type: String, required: true },
    spent: { type: Number, required: true, default: 0, min: 0 },
    slots: { type: [slotSchema], default: [] },
    purchases: { type: [purchaseSchema], default: [] },
});

addBasicPlugins(zelfKeySlotAccountSchema);

const ZelfKeySlotAccount = mongoose.models.ZelfKeySlotAccount || mongoose.model("ZelfKeySlotAccount", zelfKeySlotAccountSchema);

module.exports = ZelfKeySlotAccount;
