const jwt = require("jsonwebtoken");
const config = require("../../../Core/config");
const { signToken, TOKEN_TYPES } = require("../../../Core/jwt-claims");
const { normalizeZelfName } = require("../../Tags/modules/zelf-name.util");

/** Default lifetime when OWNER_GRANT_TTL is unset or not a positive duration. */
const DEFAULT_TTL_SECONDS = 12 * 60 * 60;

const TTL_UNITS = { s: 1, m: 60, h: 3600, d: 86400 };

/**
 * `OWNER_GRANT_TTL`: seconds (`43200`) or a number plus s/m/h/d (`12h`, `720m`).
 * Anything else, including zero, falls back to 12 hours.
 * @param {string|undefined} raw
 * @returns {number}
 */
const parseOwnerGrantTtl = (raw) => {
	if (raw == null || String(raw).trim() === "") return DEFAULT_TTL_SECONDS;
	const match = /^(\d+)\s*([smhd])?$/i.exec(String(raw).trim());
	if (!match) return DEFAULT_TTL_SECONDS;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) return DEFAULT_TTL_SECONDS;
	const unit = (match[2] || "s").toLowerCase();
	return amount * TTL_UNITS[unit];
};

/**
 * Dedicated `OWNER_GRANT_SECRET` when set.
 * Otherwise the session secret `config.JWT_SECRET` (`CONNECTION_KEY`).
 * Read on each call so replacing the env value rejects grants signed with the previous one.
 * @returns {string|null}
 */
const ownerGrantSecret = () => {
	const dedicated = process.env.OWNER_GRANT_SECRET;
	if (typeof dedicated === "string" && dedicated.trim()) return dedicated.trim();
	const fallback = config.JWT_SECRET;
	if (typeof fallback === "string" && fallback.trim()) return fallback;
	return null;
};

const ownerGrantTtlSeconds = () => parseOwnerGrantTtl(process.env.OWNER_GRANT_TTL);

/**
 * @param {string} code
 * @returns {Error}
 */
const grantError = (code) => {
	const expired = code === "ERR_OWNER_GRANT_EXPIRED";
	const error = new Error(expired ? "Owner grant has expired" : "Owner grant is invalid");
	error.status = 401;
	error.code = expired ? "ERR_OWNER_GRANT_EXPIRED" : "ERR_OWNER_GRANT_INVALID";
	return error;
};

/**
 * Fields a face-check response may add. Empty when this stamp did not mint a grant.
 * @param {Object|null|undefined} stamp
 * @returns {{ ownerGrant?: string, ownerGrantExpiresAt?: number }}
 */
const ownerGrantFields = (stamp) => {
	if (!stamp || typeof stamp.ownerGrant !== "string" || !stamp.ownerGrant) return {};
	const fields = { ownerGrant: stamp.ownerGrant };
	if (Number.isFinite(stamp.ownerGrantExpiresAt)) fields.ownerGrantExpiresAt = stamp.ownerGrantExpiresAt;
	return fields;
};

/**
 * Attach the server grant and drop any ownerGrant already on the payload.
 * A decrypted record or client body cannot supply this field.
 * @param {Object} payload
 * @param {Object|null|undefined} stamp
 * @returns {Object}
 */
const withOwnerGrant = (payload, stamp) => {
	const source = payload && typeof payload === "object" ? payload : {};
	const rest = { ...source };
	delete rest.ownerGrant;
	delete rest.ownerGrantExpiresAt;
	if (rest.publicData && typeof rest.publicData === "object") {
		rest.publicData = { ...rest.publicData };
		delete rest.publicData.ownerGrant;
		delete rest.publicData.ownerGrantExpiresAt;
	}
	return { ...rest, ...ownerGrantFields(stamp) };
};

/**
 * Sign a grant for the owner a face check just proved, bound to that session's identifier.
 * Returns null when the owner or identifier is missing, or when no signing secret is configured.
 * The caller still keeps the 10-minute session stamp in that case.
 * @param {{ zelfName: string, domain?: string, identifier: string, ttlSeconds?: number, exp?: number }} input
 * @returns {{ ownerGrant: string, ownerGrantExpiresAt: number, zelfName: string, domain: string, identifier: string }|null}
 */
const issueOwnerGrant = ({ zelfName, domain, identifier, ttlSeconds, exp }) => {
	const normalized = normalizeZelfName(zelfName, domain || "zelf");
	const device = typeof identifier === "string" ? identifier : "";
	if (!normalized.zelfName || !device) return null;

	const secret = ownerGrantSecret();
	if (!secret) return null;

	const payload = {
		sub: normalized.zelfName,
		dom: normalized.domain,
		sid_ident: device,
	};

	if (Number.isFinite(exp)) payload.exp = exp;

	const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? Math.floor(ttlSeconds) : ownerGrantTtlSeconds();
	const token = signToken(payload, secret, {
		typ: TOKEN_TYPES.ownerGrant,
		expiresIn: payload.exp == null ? ttl : undefined,
	});

	const decoded = jwt.decode(token);
	if (!decoded || !Number.isFinite(decoded.exp)) return null;

	return {
		ownerGrant: token,
		ownerGrantExpiresAt: decoded.exp,
		zelfName: normalized.zelfName,
		domain: normalized.domain,
		identifier: device,
	};
};

/**
 * Verify a presented grant. The owner is `sub` only.
 * Does not compare the device identifier; the session create path does that against the identifier it will store.
 * @param {string} token
 * @returns {{ zelfName: string, tagName: string, domain: string, identifier: string, exp: number }}
 */
const verifyOwnerGrant = (token) => {
	if (typeof token !== "string") throw grantError("ERR_OWNER_GRANT_INVALID");
	const presented = token.trim();
	if (!presented || presented.length > 8192) throw grantError("ERR_OWNER_GRANT_INVALID");

	const secret = ownerGrantSecret();
	if (!secret) throw grantError("ERR_OWNER_GRANT_INVALID");

	let claims;
	try {
		claims = jwt.verify(presented, secret, { algorithms: ["HS256"] });
	} catch (error) {
		if (error && error.name === "TokenExpiredError") throw grantError("ERR_OWNER_GRANT_EXPIRED");
		throw grantError("ERR_OWNER_GRANT_INVALID");
	}

	if (!claims || claims.typ !== TOKEN_TYPES.ownerGrant) throw grantError("ERR_OWNER_GRANT_INVALID");

	const identifier = typeof claims.sid_ident === "string" ? claims.sid_ident : "";
	const normalized = normalizeZelfName(claims.sub, typeof claims.dom === "string" && claims.dom.trim() ? claims.dom : "zelf");
	if (!normalized.zelfName || !identifier) throw grantError("ERR_OWNER_GRANT_INVALID");

	return {
		zelfName: normalized.zelfName,
		tagName: normalized.tagName,
		domain: normalized.domain,
		identifier,
		exp: claims.exp,
	};
};

module.exports = {
	DEFAULT_TTL_SECONDS,
	grantError,
	issueOwnerGrant,
	ownerGrantFields,
	withOwnerGrant,
	ownerGrantTtlSeconds,
	parseOwnerGrantTtl,
	verifyOwnerGrant,
};
