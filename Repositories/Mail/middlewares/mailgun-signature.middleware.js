const crypto = require("crypto");
const config = require("../../../Core/config");

/**
 * Verify a Mailgun webhook/route signature: HMAC-SHA256(signingKey, timestamp + token) === signature.
 * Fields come either top-level (routes/forward) or under `signature` (event webhooks).
 */
const verifySignature = ({ timestamp, token, signature }, signingKey, nowSec = Math.floor(Date.now() / 1000), maxSkewSec = 300) => {
	if (!signingKey) return { ok: false, reason: "signing_key_not_configured" };
	if (!timestamp || !token || !signature) return { ok: false, reason: "missing_signature_fields" };

	const ts = Number(timestamp);
	if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > maxSkewSec) return { ok: false, reason: "stale_timestamp" };

	const expected = crypto.createHmac("sha256", signingKey).update(String(timestamp) + String(token)).digest("hex");
	const a = Buffer.from(expected, "utf8");
	const b = Buffer.from(String(signature), "utf8");
	if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };

	return { ok: true };
};

const extractSignatureFields = (body = {}) => {
	const nested = body.signature && typeof body.signature === "object" ? body.signature : null;
	if (nested) return { timestamp: nested.timestamp, token: nested.token, signature: nested.signature };
	return { timestamp: body.timestamp, token: body.token, signature: body.signature };
};

const mailgunSignatureValidator = async (ctx, next) => {
	const body = ctx.request.body || {};
	const result = verifySignature(
		extractSignatureFields(body),
		config.email_providers.mailgun.webhookSigningKey,
		Math.floor(Date.now() / 1000),
		config.jimInbound.maxTimestampSkewSec
	);

	if (!result.ok) {
		// 406 tells Mailgun not to retry.
		ctx.status = 406;
		ctx.body = { error: result.reason };
		return;
	}

	await next();
};

module.exports = { verifySignature, extractSignatureFields, mailgunSignatureValidator };
