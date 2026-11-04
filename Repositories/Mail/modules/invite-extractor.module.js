const jwt = require("jsonwebtoken");
const config = require("../../../Core/config");

const INVITE_URL_RE = /https?:\/\/[^\s"'<>]+\/auth\/accept-invite\?token=([A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+)/i;

const maskToken = (token) => (token ? `…${String(token).slice(-6)}` : null);

const decodeEntities = (s) => String(s || "").replace(/&amp;/g, "&");

/**
 * Find a Zelf staff invitation link in an email and validate its JWT.
 * Notify-only: this never accepts the invite (accept requires a live face scan).
 * The decoded token carries the owner's apiKey/zkProof, so only safe fields are returned.
 */
const extractInvite = ({ textPlain, html }, { recipients = [], secret = config.JWT_SECRET } = {}) => {
	const haystack = `${textPlain || ""}\n${decodeEntities(html)}`;
	const match = haystack.match(INVITE_URL_RE);
	if (!match) return null;

	const link = match[0];
	const token = match[1];
	const base = { link, token, tokenMasked: maskToken(token) };

	let decoded;
	try {
		decoded = jwt.verify(token, secret);
	} catch (error) {
		const expired = error?.name === "TokenExpiredError";
		const loose = jwt.decode(token) || {};
		return {
			...base,
			valid: false,
			reason: expired ? "expired" : "invalid_signature",
			staffEmail: loose.staffEmail,
			company: loose.ownerCompany,
			role: loose.role,
			expiresAt: loose.exp ? new Date(loose.exp * 1000) : undefined,
		};
	}

	const safe = {
		staffEmail: decoded.staffEmail,
		ownerEmail: decoded.ownerEmail,
		company: decoded.ownerCompany,
		role: decoded.role,
		expiresAt: decoded.exp ? new Date(decoded.exp * 1000) : undefined,
	};

	if (decoded.type !== "staff_invitation") return { ...base, ...safe, valid: false, reason: "wrong_type" };

	const lower = recipients.map((r) => r.toLowerCase());
	if (lower.length && !lower.includes(String(decoded.staffEmail || "").toLowerCase())) {
		return { ...base, ...safe, valid: false, reason: "staff_email_mismatch" };
	}

	return { ...base, ...safe, valid: true, reason: "ok" };
};

module.exports = { extractInvite, maskToken, INVITE_URL_RE };
