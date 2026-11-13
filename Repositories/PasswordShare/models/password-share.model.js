const mongoose = require("mongoose");

const { Schema } = mongoose;

/**
 * One secure-share link.
 *
 * The extension encrypts the item (AES-256-GCM) and uploads ciphertext + IV only.
 * The 256-bit key stays in the URL fragment on the landing page. This document
 * has no field for the key, the password, or any other plaintext.
 *
 * `expiresAt` is a TTL index (expireAfterSeconds: 0). Mongo deletes the row
 * after that instant; the API still refuses a row that is past `expiresAt`
 * but not yet reaped.
 */
const PasswordShareSchema = new Schema(
	{
		/** Unguessable public id (256-bit, base64url). This is the path segment. */
		shareId: { type: String, required: true, unique: true },

		/** Session `identifier` from POST /api/sessions. Ownership checks use only this. */
		ownerIdentifier: { type: String, required: true },

		/** Display-only copy of the session tag, when the client sent one. Not an authz key. */
		ownerTagName: { type: String, default: null },

		/** Standard base64 ciphertext. Nulled when the last view is consumed or the owner revokes. */
		ciphertext: { type: String, default: null },

		/** Standard base64 12-byte AES-GCM IV. Nulled together with ciphertext. */
		iv: { type: String, default: null },

		version: { type: Number, required: true },

		/** Optional non-secret hint. Never required to decrypt. */
		label: { type: String, default: null },

		maxViews: { type: Number, required: true },
		remainingViews: { type: Number, required: true },

		expiresAt: { type: Date, required: true },
		revokedAt: { type: Date, default: null },
		consumedAt: { type: Date, default: null },
	},
	{ timestamps: true, collection: "PasswordShares" }
);

PasswordShareSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
PasswordShareSchema.index({ ownerIdentifier: 1, createdAt: -1 });

module.exports = mongoose.models.PasswordShare || mongoose.model("PasswordShare", PasswordShareSchema);
