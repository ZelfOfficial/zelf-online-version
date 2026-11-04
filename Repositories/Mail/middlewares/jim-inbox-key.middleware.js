const crypto = require("crypto");
const config = require("../../../Core/config");

// Hash both sides so the compare is constant-time regardless of length.
const digest = (v) => crypto.createHash("sha256").update(String(v)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

const presentedKey = (headers = {}) => {
	if (headers["x-jim-inbox-key"]) return String(headers["x-jim-inbox-key"]);
	const auth = String(headers.authorization || "");
	return auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
};

/** Static key for Jim's mailbox endpoints only: `x-jim-inbox-key: <JIM_INBOX_API_KEY>` or `Authorization: Bearer <key>`. */
const jimInboxKeyValidator = async (ctx, next) => {
	const secret = config.jimInbound.inboxApiKey;
	if (!secret) {
		ctx.status = 503;
		ctx.body = { error: "jim_inbox_key_not_configured" };
		return;
	}

	const key = presentedKey(ctx.headers);
	if (!key || !safeEqual(key, secret)) {
		ctx.status = 401;
		ctx.body = { error: "unauthorized" };
		return;
	}

	ctx.state.inboundActor = "jim-inbox-key";
	await next();
};

module.exports = { jimInboxKeyValidator, presentedKey };
