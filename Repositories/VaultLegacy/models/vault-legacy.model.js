const mongoose = require("mongoose");

const Schema = mongoose.Schema;
const { String, Boolean } = mongoose.Schema.Types;

const { defaultField, addBasicPlugins } = require("../../../Core/mongoose-utils");

// ─────────────────────────────────────────────────────────────────────────────
// VaultLegacyEmail — stores email addresses associated with each on-chain vault
// and tracks which notification events have already been sent (replacing the
// old file-based vault_emails.json + notified_events.json approach).
// ─────────────────────────────────────────────────────────────────────────────

const VaultLegacySchema = new Schema({
    // Unique on-chain vault identifier (bytes32 hex string, e.g. "0x26799d71...")
    vaultId: { type: String, required: true, unique: true, index: true },

    // E-mail addresses captured before the vault is written to chain
    testatorEmail: defaultField(String, null),
    lawyerEmail: defaultField(String, null),
    beneficiaryEmails: { type: [String], default: [] },

    // ZNS tag names for each beneficiary (positionally aligned with beneficiaryEmails)
    beneficiaryTagNames: { type: [String], default: [] },

    // Tracks which notification e-mails have already been dispatched.
    // Keys are event names (e.g. "createVault", "gracePeriod", "livenessFailed"),
    // values are ISO-8601 timestamps of when the e-mail was sent.
    notifiedEvents: { type: Schema.Types.Mixed, default: {} },

    /** Demo inheritance plan — automation only when LEGACY_DEMO_MODE=true */
    isDemo: { type: Boolean, default: false, index: true },
});

addBasicPlugins(VaultLegacySchema);

const VaultLegacy = mongoose.model("VaultLegacy", VaultLegacySchema);

module.exports = VaultLegacy;
