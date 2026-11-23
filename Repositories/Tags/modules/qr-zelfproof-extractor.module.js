const { Buffer } = require("buffer");
const { fetchAllowedImage } = require("../../../Core/safe-image-fetch");

// Use sharp for image decoding (avoids canvas/sharp native lib conflict)
let sharp;

// QRCode is used to generate QR images from a raw ZelfProof string
let QRCode = require("qrcode");


try {
	sharp = require("sharp");
} catch (error) {
	console.warn("Sharp module not available, QR extraction will be limited");
	sharp = null;
}

// zxing-wasm is more robust than jsQR for dense binary QR codes (e.g. ZelfProof)
let readBarcodesFromImageData = null;
try {
	readBarcodesFromImageData = require("zxing-wasm").readBarcodesFromImageData;
} catch (error) {
	console.warn("zxing-wasm not available for QR extraction:", error.message);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

function _isPNG(buffer) {
	return buffer.length >= 8 && buffer.slice(0, 8).equals(PNG_SIGNATURE);
}

function _isJPEG(buffer) {
	return buffer.length >= 3 && buffer.slice(0, 3).equals(JPEG_SIGNATURE);
}

function _isSupportedImage(buffer) {
	return _isPNG(buffer) || _isJPEG(buffer);
}

/**
 * Decode image buffer to RGBA pixel data for zxing-wasm
 * @param {Buffer} imageBuffer - PNG or JPEG image buffer
 * @returns {Promise<{data: Uint8ClampedArray, width: number, height: number}|null>}
 */
async function getImageDataFromBuffer(imageBuffer) {
	if (!sharp) return null;
	try {
		const { data, info } = await sharp(imageBuffer)
			.ensureAlpha()
			.raw()
			.toBuffer({ resolveWithObject: true });
		return {
			data: new Uint8ClampedArray(data),
			width: info.width,
			height: info.height,
		};
	} catch (err) {
		console.warn("Sharp failed to decode image:", err.message);
		return null;
	}
}

/**
 * Utility class for extracting ZelfProof from QR codes
 * Converts base64 PNG/JPEG images containing QR codes to ZelfProof binary data
 */
class QRZelfProofExtractor {
	/**
	 * Extracts ZelfProof from a base64 encoded PNG or JPEG QR code image
	 * @param {string} base64Image - Base64 encoded PNG or JPEG image (with or without data URL prefix)
	 * @returns {Promise<string|null>} - Base64 encoded ZelfProof or null if extraction fails
	 */
	static async extractZelfProof(base64Image) {
		if (!base64Image) return null;

		const imageSource = typeof base64Image === "string" ? base64Image.trim() : "";
		if (/^https:\/\//i.test(imageSource)) {
			try {
				const { buffer, contentType } = await fetchAllowedImage(imageSource);
				const mime = contentType.startsWith("image/jpeg") ? "image/jpeg" : "image/png";
				base64Image = `data:${mime};base64,${buffer.toString("base64")}`;
			} catch (fetchError) {
				console.warn("extractZelfProof: image fetch rejected:", fetchError.code || fetchError.message);
				return null;
			}
		}

		try {
			if (!sharp) {
				console.warn("Sharp module not available, cannot extract ZelfProof from QR code");
				return null;
			}

			const cleanBase64 = this._cleanBase64String(base64Image);
			const imageBuffer = Buffer.from(cleanBase64, "base64");

			if (!_isSupportedImage(imageBuffer)) {
				const detected =
					imageBuffer[0] === 0xff && imageBuffer[1] === 0xd8
						? "JPEG"
						: imageBuffer[0] === 0x89
							? "possibly corrupted PNG"
							: "unknown";
				console.warn(
					`ZelfProof QR expected PNG or JPEG, got ${detected} (first bytes: ${imageBuffer.slice(0, 4).toString("hex")})`
				);
				return null;
			}

			const imageData = await getImageDataFromBuffer(imageBuffer);

			if (!imageData) return null;

			if (!readBarcodesFromImageData) {
				console.warn("No QR code reader available (zxing-wasm)");
				return null;
			}

			const results = await readBarcodesFromImageData(
				{
					data: imageData.data,
					width: imageData.width,
					height: imageData.height,
				},
				{
					formats: ["QRCode"],
					tryHarder: true,
					tryDownscale: true,
					tryRotate: true,
					tryInvert: true,
					maxNumberOfSymbols: 1,
				}
			);

			if (!results || results.length === 0) return null;

			const result = results[0];

			// Prefer raw bytes (binary ZelfProof) over text
			if (result.bytes && result.bytes.length > 0) {
				return Buffer.from(result.bytes).toString("base64");
			}

			// Fallback: if only text is available, try to interpret it
			if (result.text) {
				const text = result.text;
				if (this._isBase64(text)) return text;
				if (this._isHex(text)) {
					return Buffer.from(text.replace(/\s/g, ""), "hex").toString("base64");
				}
				return Buffer.from(text, "utf8").toString("base64");
			}

			return null;
		} catch (error) {
			console.error("Error extracting ZelfProof from QR code:", error);
			return null;
		}
	}

	/**
	 * Cleans base64 string by removing data URL prefix if present
	 * @param {string} base64String - Raw base64 string
	 * @returns {string} - Clean base64 string
	 * @private
	 */
	static _cleanBase64String(base64String) {
		// Remove data URL prefix if present (e.g., "data:image/png;base64,")
		if (base64String.includes(",")) {
			return base64String.split(",")[1];
		}
		return base64String;
	}

	/**
	 * Checks if a string is valid base64
	 * @param {string} str - String to check
	 * @returns {boolean} - True if string is valid base64
	 * @private
	 */
	static _isBase64(str) {
		try {
			return Buffer.from(str, "base64").toString("base64") === str;
		} catch (err) {
			return false;
		}
	}

	/**
	 * Checks if a string is valid hex
	 * @param {string} str - String to check
	 * @returns {boolean} - True if string is valid hex
	 * @private
	 */
	static _isHex(str) {
		return /^[0-9a-fA-F\s]+$/.test(str);
	}

	/**
	 * Converts binary data to hex string
	 * @param {Uint8Array} binaryData - Binary data to convert
	 * @returns {string} - Hex string representation
	 * @private
	 */
	static _toHexString(binaryData) {
		return Array.from(binaryData)
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
	}

	/**
	 * Validates if the extracted data looks like a valid ZelfProof
	 * @param {string} zelfProof - Base64 encoded ZelfProof
	 * @returns {boolean} - True if data appears to be valid ZelfProof
	 */
	static validateZelfProof(zelfProof) {
		if (!zelfProof || typeof zelfProof !== "string") {
			return false;
		}

		// Basic validation: check if it's valid base64 and has reasonable length
		try {
			const buffer = Buffer.from(zelfProof, "base64");
			// ZelfProof should be at least some minimum size (adjust as needed)
			return buffer.length > 0;
		} catch (error) {
			return false;
		}
	}
}

/**
 * Convenience function for quick ZelfProof extraction
 * @param {string} base64Image - Base64 encoded PNG or JPEG image
 * @returns {Promise<string|null>} - Base64 encoded ZelfProof or null
 */
async function extractZelfProofFromQR(base64Image) {
	return await QRZelfProofExtractor.extractZelfProof(base64Image);
}

/**
 * QR version-40 byte-mode capacities (ISO). Prefer the strongest ECC that still
 * fits so 3.1.6 proofs stay on H and default v4 proofs (~1325 bytes) still encode.
 * SenseCrypt's own /encrypt-qr-code drops to L once H/Q/M overflow.
 */
const QR_BYTE_CAPACITY = Object.freeze({
	H: 1273,
	Q: 1663,
	M: 2331,
	L: 2953,
});
const QR_ECC_STRONGEST_FIRST = Object.freeze(["H", "Q", "M", "L"]);

/**
 * Strongest error-correction level that can hold `byteCount` bytes in one QR.
 * @param {number} byteCount raw SensePrint length
 * @returns {"H"|"Q"|"M"|"L"|null} `null` when even L cannot hold it (over 2953)
 */
function errorCorrectionLevelForProofBytes(byteCount) {
	const n = Number(byteCount) || 0;
	for (const level of QR_ECC_STRONGEST_FIRST) {
		if (n <= QR_BYTE_CAPACITY[level]) return level;
	}
	return null;
}

/**
 * ECC levels to try: requested first (if valid), then H → Q → M → L.
 * The `qrcode` library can sit a few bytes under the ISO max, so we fall
 * through instead of trusting the capacity table alone.
 * @param {string} [requested]
 * @returns {string[]}
 */
function errorCorrectionLevelsToTry(requested) {
	const all = [...QR_ECC_STRONGEST_FIRST];
	if (requested && all.includes(requested)) {
		return [requested, ...all.filter((level) => level !== requested)];
	}
	return all;
}

/**
 * Computes optimal QR pixel size based on ZelfProof binary byte length.
 * Larger ZelfProofs produce denser QR codes that require more pixels per module
 * to remain reliably scannable on mobile devices (≥3.125 px/module recommended).
 *
 * Formula: estimate QR version from byte count, then size = modules × px/module.
 * 3.1.6 (H): 3.125 px/module, clamped to [320, 640].
 * v4 past H: 4.52 px/module so a version-40 QR (177 modules) renders at 800px.
 *
 * @param {number} byteCount - Length of the raw ZelfProof buffer
 * @returns {number} - Recommended pixel width/height
 */
function getOptimalQRSize(byteCount) {
	const version = Math.max(1, Math.min(40, Math.ceil(byteCount / 32)));
	const modules = 17 + 4 * version;
	const pastH = byteCount > QR_BYTE_CAPACITY.H;
	const pixelsPerModule = pastH ? 4.52 : 3.125;
	const max = pastH ? 800 : 640;
	return Math.max(320, Math.min(max, Math.ceil(modules * pixelsPerModule)));
}

/**
 * Generates a QR code PNG image from a base64-encoded ZelfProof string.
 * Encodes the raw binary data (byte mode) so the QR is identical to the original.
 * Image size is computed automatically from the ZelfProof byte length.
 *
 * Error correction defaults to the strongest level that still fits (H for 3.1.6,
 * Q/M/L for larger v4 proofs). If an explicit level cannot encode, lower levels
 * are tried so a default v4 SensePrint does not return null.
 *
 * @param {string} zelfProof - Base64-encoded ZelfProof
 * @param {Object} [options]
 * @param {number} [options.size] - Width/height in px (default: auto via getOptimalQRSize)
 * @param {string} [options.errorCorrectionLevel] preferred ECC; falls back if too small
 * @param {number} [options.margin=2] - Quiet zone modules around the QR code
 * @returns {Promise<string|null>} - data:image/png;base64,... or null on failure
 */
async function generateQRFromZelfProof(zelfProof, options = {}) {
	if (!zelfProof || typeof zelfProof !== "string") return null;
	if (!QRCode) {
		console.warn("qrcode module not available, cannot generate QR from ZelfProof");
		return null;
	}

	const buffer = Buffer.from(zelfProof, "base64");
	const size = options.size ?? getOptimalQRSize(buffer.length);
	const { margin = 2 } = options;
	const levels = errorCorrectionLevelsToTry(options.errorCorrectionLevel);

	let lastError = null;
	for (const errorCorrectionLevel of levels) {
		try {
			return await QRCode.toDataURL([{ data: buffer, mode: "byte" }], {
				type: "png",
				width: size,
				margin,
				errorCorrectionLevel,
			});
		} catch (error) {
			lastError = error;
		}
	}

	console.error(
		"generateQRFromZelfProof failed:",
		lastError?.message || "QR capacity exceeded",
		{ bytes: buffer.length, tried: levels }
	);
	return null;
}

module.exports = {
	QRZelfProofExtractor,
	extractZelfProofFromQR,
	generateQRFromZelfProof,
	getOptimalQRSize,
	errorCorrectionLevelForProofBytes,
	QR_BYTE_CAPACITY,
};
