/**
 * Ciphertext blob storage for zSend.
 *
 * Convenience only: small ciphertext can be handed to zSend, which pins it and
 * returns a pointer. Larger transfers should be uploaded by the client so the
 * payload never transits the API. Either way the bytes are already encrypted —
 * zSend has no way to read them.
 */
const IPFS = require("../../../Core/ipfs");
const PurposeModule = require("./zsend-purpose.module");
const { fail } = require("./zsend-errors.module");

/**
 * Pin an already-encrypted payload and return its pointer.
 *
 * @param {Object} params
 * @param {string} params.cipherBase64 base64 ciphertext
 * @param {string} [params.filename]
 * @param {Object} authUser
 * @returns {Promise<{ cid: string, url: string, byteLength: number, sha256: string }>}
 */
const pinCiphertext = async (params, authUser) => {
	if (!authUser?.identifier) fail(401, "missing_session_identifier");

	const byteLength = PurposeModule.base64ByteLength(params.cipherBase64);

	if (!byteLength) fail(409, "missing_cipherBase64");

	if (byteLength > PurposeModule.MAX_INLINE_BLOB_BYTES) fail(413, "cipher_too_large_upload_directly");

	const filename = params.filename || `zsend-${Date.now()}.bin`;

	// Keyvalues stay minimal on purpose: pin metadata is public and searchable.
	const pinned = await IPFS.pinFile(params.cipherBase64, filename, "application/octet-stream", {
		zsend: "envelope-cipher",
	});

	if (!pinned?.cid) fail(502, "ipfs_pin_failed");

	return {
		cid: pinned.cid,
		url: pinned.url,
		byteLength,
		sha256: PurposeModule.sha256OfBase64(params.cipherBase64),
	};
};

/**
 * Delete the pin zSend created for this ciphertext.
 * The Pinata SDK deletes by file id, so the CID is resolved first.
 * A failure is logged and does not block the envelope update.
 * @param {string} cid
 */
const unpinCiphertext = async (cid) => {
	if (!cid) return false;

	try {
		await IPFS.unPinFiles([cid]);

		return true;
	} catch (exception) {
		console.error("zsend_unpin_failed", { cid, code: exception?.code || null, message: exception?.message });

		return false;
	}
};

module.exports = {
	pinCiphertext,
	unpinCiphertext,
};
