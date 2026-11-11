const { randomBytes } = require("crypto");
const mongoose = require("mongoose");

const Model = require("../models/password-share.model");
const { fail } = require("./password-share-errors");

/** Decoded ciphertext cap. 16 KiB. */
const MAX_CIPHERTEXT_BYTES = 16 * 1024;

/** Standard base64 length of MAX_CIPHERTEXT_BYTES (16384 % 3 === 1, so two padding chars). */
const MAX_CIPHERTEXT_BASE64_LENGTH = 21848;

const MAX_LABEL_LENGTH = 60;
const IV_BYTES = 12;
const SHARE_ID_BYTES = 32;
const VERSION = 1;
const ALLOWED_EXPIRES_IN = new Set([3600, 86400, 604800, 2592000]);
const MAX_VIEWS = 10;
const LIST_LIMIT = 100;

/** Body fields that would mean the client sent key material or plaintext. Never stored. */
const REJECTED_BODY_FIELDS = ["key", "password", "plaintext", "secret", "dek", "contentKey", "aesKey", "encryptionKey"];

const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;

let indexesReady = null;

/**
 * Build the unique id index and the expiresAt TTL index.
 * Production may leave mongoose autoIndex off, so this is called on connect
 * and again before the first write.
 */
const ensureIndexes = () => {
	if (mongoose.connection.readyState !== 1) return Promise.resolve();
	if (!indexesReady) {
		indexesReady = Model.createIndexes().catch((error) => {
			indexesReady = null;
			console.error("PasswordShare index creation failed:", error.code || error.name);
			throw error;
		});
	}
	return indexesReady;
};

const readyIndexes = async () => {
	try {
		await ensureIndexes();
	} catch (_error) {
		// A failed index build is logged above. The request still runs.
	}
};

/**
 * PLAN_LIMIT_HOOK
 * No per-plan or license cap yet. `activeCount` is how many active shares
 * this owner already has. When product defines a quota, enforce it here
 * before insert and throw a coded error. Do not add a silent limit.
 * @param {{ ownerIdentifier: string, activeCount: number }} _owner
 */
const assertOwnerMayCreateShare = async (_owner) => {
	// PLAN_LIMIT_HOOK: no quota yet. `_owner.activeCount` is the live count.
	void _owner;
};

const ownerFromSession = (user) => {
	const identifier = typeof user?.identifier === "string" ? user.identifier.trim() : "";
	if (!identifier) fail(401, "SHARE_SESSION_REQUIRED");

	const tagName = typeof user?.tagName === "string" ? user.tagName.trim().toLowerCase() : "";

	return {
		ownerIdentifier: identifier.slice(0, 256),
		ownerTagName: tagName ? tagName.slice(0, 120) : null,
	};
};

const assertNoKeyMaterial = (body) => {
	if (!body || typeof body !== "object") return;

	for (const field of REJECTED_BODY_FIELDS) {
		if (Object.prototype.hasOwnProperty.call(body, field) && body[field] != null && body[field] !== "") {
			fail(400, "SHARE_KEY_NOT_ACCEPTED");
		}
	}
};

/**
 * Strict standard base64. Returns the decoded bytes plus the canonical padded form.
 * @param {string} value
 * @returns {{ buffer: Buffer, base64: string } | null}
 */
const decodeBase64 = (value) => {
	if (typeof value !== "string") return null;

	const trimmed = value.trim();
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return null;
	if (trimmed.length % 4 === 1) return null;

	const buffer = Buffer.from(trimmed, "base64");
	if (!buffer.length) return null;

	const canonical = buffer.toString("base64").replace(/=+$/, "");
	const given = trimmed.replace(/=+$/, "");
	if (canonical !== given) return null;

	return { buffer, base64: buffer.toString("base64") };
};

const parseCiphertext = (value) => {
	if (typeof value !== "string" || !value.trim()) fail(400, "INVALID_CIPHERTEXT");
	if (value.trim().length > MAX_CIPHERTEXT_BASE64_LENGTH) fail(413, "SHARE_TOO_LARGE");

	const decoded = decodeBase64(value);
	if (!decoded) fail(400, "INVALID_CIPHERTEXT");
	if (decoded.buffer.length > MAX_CIPHERTEXT_BYTES) fail(413, "SHARE_TOO_LARGE");

	return decoded.base64;
};

const parseIv = (value) => {
	const decoded = typeof value === "string" ? decodeBase64(value) : null;
	if (!decoded || decoded.buffer.length !== IV_BYTES) fail(400, "INVALID_IV");
	return decoded.base64;
};

const parseLabel = (value) => {
	if (value == null) return null;
	if (typeof value !== "string") fail(400, "INVALID_LABEL");

	const label = value.trim();
	if (!label) return null;
	if (label.length > MAX_LABEL_LENGTH) fail(400, "INVALID_LABEL");
	if (/[\u0000-\u001F\u007F]/.test(label)) fail(400, "INVALID_LABEL");

	return label;
};

const parseCreateBody = (body) => {
	assertNoKeyMaterial(body);

	const payload = body && typeof body === "object" && !Array.isArray(body) ? body : null;
	if (!payload) fail(400, "INVALID_CIPHERTEXT");

	const ciphertext = parseCiphertext(payload.ciphertext);
	const iv = parseIv(payload.iv);

	if (payload.version !== VERSION) fail(400, "INVALID_VERSION");
	if (!Number.isInteger(payload.expiresIn) || !ALLOWED_EXPIRES_IN.has(payload.expiresIn)) {
		fail(400, "INVALID_EXPIRATION");
	}

	const maxViews = payload.maxViews === undefined ? 1 : payload.maxViews;
	if (!Number.isInteger(maxViews) || maxViews < 1 || maxViews > MAX_VIEWS) {
		fail(400, "INVALID_MAX_VIEWS");
	}

	return {
		ciphertext,
		iv,
		version: VERSION,
		expiresIn: payload.expiresIn,
		maxViews,
		label: parseLabel(payload.label),
	};
};

const normalizeId = (id) => {
	if (typeof id !== "string") return null;
	const trimmed = id.trim();
	if (!SHARE_ID_PATTERN.test(trimmed)) return null;
	return trimmed;
};

const iso = (value) => new Date(value).toISOString();

const activeFilter = (now) => ({
	revokedAt: null,
	expiresAt: { $gt: now },
	remainingViews: { $gt: 0 },
	ciphertext: { $type: "string", $ne: "" },
});

/**
 * Public absence vs expiry. Revoked and consumed rows are "missing" so the
 * caller cannot tell them apart from an id that never existed. A row that is
 * only expired (TTL has not reaped it) is "expired".
 */
const classifyShell = (share, now) => {
	if (!share || share.revokedAt) return "missing";
	if (share.expiresAt && new Date(share.expiresAt).getTime() <= now.getTime()) return "expired";
	return "missing";
};

const refuseMissing = (state) => {
	if (state === "expired") fail(410, "SHARE_EXPIRED");
	fail(404, "SHARE_NOT_FOUND");
};

const hideDriverError = (error) => {
	if (error && error.clientCode) throw error;
	console.error("password share failed", error && (error.code || error.name));
	fail(500, "SHARE_UNAVAILABLE");
};

const createShare = async (body, user) => {
	try {
		await readyIndexes();
		const owner = ownerFromSession(user);
		const parsed = parseCreateBody(body);
		const now = new Date();
		const activeCount = await Model.countDocuments({
			ownerIdentifier: owner.ownerIdentifier,
			...activeFilter(now),
		});
		await assertOwnerMayCreateShare({ ownerIdentifier: owner.ownerIdentifier, activeCount });

		const expiresAt = new Date(now.getTime() + parsed.expiresIn * 1000);
		const shareId = randomBytes(SHARE_ID_BYTES).toString("base64url");

		await Model.create({
			shareId,
			ownerIdentifier: owner.ownerIdentifier,
			ownerTagName: owner.ownerTagName,
			ciphertext: parsed.ciphertext,
			iv: parsed.iv,
			version: parsed.version,
			label: parsed.label,
			maxViews: parsed.maxViews,
			remainingViews: parsed.maxViews,
			expiresAt,
			revokedAt: null,
			consumedAt: null,
		});

		return {
			id: shareId,
			expiresAt: expiresAt.toISOString(),
			maxViews: parsed.maxViews,
		};
	} catch (error) {
		hideDriverError(error);
	}
};

const getMetadata = async (id) => {
	try {
		await readyIndexes();
		const shareId = normalizeId(id);
		const now = new Date();
		if (!shareId) fail(404, "SHARE_NOT_FOUND");

		// Ciphertext is intentionally not selected. Previews and bots hit this route.
		const share = await Model.findOne({
			shareId,
			revokedAt: null,
			remainingViews: { $gt: 0 },
			ciphertext: { $type: "string", $ne: "" },
		})
			.select("shareId label expiresAt remainingViews")
			.lean();

		if (!share) {
			const shell = await Model.findOne({ shareId }).select("revokedAt expiresAt").lean();
			refuseMissing(classifyShell(shell, now));
		}

		if (new Date(share.expiresAt).getTime() <= now.getTime()) fail(410, "SHARE_EXPIRED");

		const body = {
			id: share.shareId,
			expiresAt: iso(share.expiresAt),
			remainingViews: share.remainingViews,
		};
		if (share.label) body.label = share.label;
		return body;
	} catch (error) {
		hideDriverError(error);
	}
};

const revealShare = async (id) => {
	try {
		await readyIndexes();
		const shareId = normalizeId(id);
		const now = new Date();
		if (!shareId) fail(404, "SHARE_NOT_FOUND");

		// One document update matches remainingViews > 0. Two concurrent reveals
		// of a 1-view share cannot both pass this filter.
		const before = await Model.findOneAndUpdate(
			{
				shareId,
				revokedAt: null,
				expiresAt: { $gt: now },
				remainingViews: { $gt: 0 },
				ciphertext: { $type: "string", $ne: "" },
			},
			{ $inc: { remainingViews: -1 } },
			{ new: false }
		).lean();

		if (!before) {
			const shell = await Model.findOne({ shareId }).select("revokedAt expiresAt").lean();
			refuseMissing(classifyShell(shell, now));
		}

		const remainingViews = before.remainingViews - 1;
		const payload = {
			ciphertext: before.ciphertext,
			iv: before.iv,
			version: before.version,
			expiresAt: iso(before.expiresAt),
			remainingViews,
		};

		if (remainingViews <= 0) {
			try {
				await Model.updateOne(
					{ _id: before._id, remainingViews: 0 },
					{ $set: { ciphertext: null, iv: null, consumedAt: now } }
				);
			} catch (purgeError) {
				// The view is already spent. Still return the ciphertext to the winner.
				console.error("password share purge failed", purgeError.code || purgeError.name);
			}
		}

		return payload;
	} catch (error) {
		hideDriverError(error);
	}
};

const listShares = async (user) => {
	try {
		await readyIndexes();
		const owner = ownerFromSession(user);
		const now = new Date();
		const rows = await Model.find({
			ownerIdentifier: owner.ownerIdentifier,
			...activeFilter(now),
		})
			.sort({ createdAt: -1 })
			.limit(LIST_LIMIT)
			.select("shareId label createdAt expiresAt remainingViews maxViews")
			.lean();

		return {
			shares: rows.map((row) => {
				const item = {
					id: row.shareId,
					createdAt: iso(row.createdAt),
					expiresAt: iso(row.expiresAt),
					remainingViews: row.remainingViews,
					maxViews: row.maxViews,
				};
				if (row.label) item.label = row.label;
				return item;
			}),
		};
	} catch (error) {
		hideDriverError(error);
	}
};

const revokeShare = async (id, user) => {
	try {
		await readyIndexes();
		const owner = ownerFromSession(user);
		const shareId = normalizeId(id);
		if (!shareId) fail(404, "SHARE_NOT_FOUND");

		const share = await Model.findOne({ shareId }).select("ownerIdentifier revokedAt").lean();
		if (!share) fail(404, "SHARE_NOT_FOUND");
		if (share.ownerIdentifier !== owner.ownerIdentifier) fail(403, "SHARE_FORBIDDEN");

		if (!share.revokedAt) {
			await Model.updateOne(
				{ _id: share._id, ownerIdentifier: owner.ownerIdentifier },
				{ $set: { revokedAt: new Date(), ciphertext: null, iv: null } }
			);
		}

		return { id: shareId, revoked: true };
	} catch (error) {
		hideDriverError(error);
	}
};

module.exports = {
	ALLOWED_EXPIRES_IN,
	IV_BYTES,
	LIST_LIMIT,
	MAX_CIPHERTEXT_BYTES,
	MAX_LABEL_LENGTH,
	MAX_VIEWS,
	SHARE_ID_BYTES,
	VERSION,
	assertOwnerMayCreateShare,
	createShare,
	ensureIndexes,
	getMetadata,
	listShares,
	revealShare,
	revokeShare,
};
