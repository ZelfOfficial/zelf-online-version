/**
 * Identity token (returned inline from a successful decrypt) and the zAI token derived from it.
 * Feature-gated: without IDENTITY_JWT_SECRET nothing is issued and decrypt responses are unchanged.
 * See /workspace zAI contract §2.
 */
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const RevokedToken = require("../models/zai-revoked-token.model");

const IDENTITY_TTL_SECONDS = 60 * 60;
const ZAI_TTL_SECONDS = 15 * 60;
const ADDRESS_KEYS = [
    "ethAddress",
    "solanaAddress",
    "btcAddress",
    "suiAddress",
    "tonAddress",
    "aptosAddress",
    "xlmAddress",
    "avalancheAddress",
    "dotAddress",
    "ksmAddress",
];

const identitySecret = () => process.env.IDENTITY_JWT_SECRET || null;
const zaiSecret = () => process.env.ZAI_JWT_SECRET || null;
const isIdentityEnabled = () => !!identitySecret();
const isZaiEnabled = () => !!identitySecret() && !!zaiSecret();

/** Errors in the "NNN:CODE" + clientCode format that Core/http-handler errorHandler maps to { status, message, code }. */
const zaiError = (status, code) => {
    const error = new Error(`${status}:${code}`);
    error.status = status;
    error.code = code;
    error.clientCode = code;
    error.clientMessage = code;
    return error;
};

const fullName = (record, domain) => {
    const data = record?.publicData || {};
    const name = String(data.zelfName || data.tagName || record?.name || "")
        .trim()
        .toLowerCase()
        .replace(/\.hold$/, "");
    if (!name) return null;
    if (name.includes(".")) return name;
    const dom = String(domain || data.domain || record?.domain || "zelf")
        .replace(/^\./, "")
        .toLowerCase();
    return `${name}.${dom}`;
};

const recordId = (record) => {
    const ipfs = Array.isArray(record?.ipfs) ? record.ipfs[0] : record?.ipfs;
    const arweave = Array.isArray(record?.arweave) ? record.arweave[0] : record?.arweave;
    return String(record?.id || ipfs?.id || ipfs?.cid || ipfs?.ipfs_pin_hash || arweave?.id || record?.ipfs_pin_hash || "") || null;
};

const addressesOf = (record) => {
    const data = record?.publicData || {};
    const addresses = {};
    for (const key of ADDRESS_KEYS) if (typeof data[key] === "string" && data[key]) addresses[key.replace(/Address$/, "")] = data[key];
    return addresses;
};

/**
 * Sign an identity token from a decrypted record. Returns null when disabled or when the record has no name.
 * Never throws (decrypt must behave exactly as before on any problem here).
 */
const issueIdentityToken = (record, domain) => {
    try {
        const secret = identitySecret();
        if (!secret) return null;
        const sub = fullName(record, domain);
        if (!sub) return null;
        return jwt.sign({ typ: "identity", sub, zid: recordId(record), addr: addressesOf(record), jti: crypto.randomUUID() }, secret, {
            expiresIn: IDENTITY_TTL_SECONDS,
        });
    } catch (error) {
        console.error("identityToken issue failed:", error.message);
        return null;
    }
};

/** Adds data.identityToken to a decrypt result when the feature is enabled. Mutates and returns `data`. */
const attachIdentityToken = (data, domain) => {
    if (!data || typeof data !== "object" || !isIdentityEnabled()) return data;
    const token = issueIdentityToken(data, domain);
    if (token) data.identityToken = token;
    return data;
};

const isRevoked = async (jtis) => {
    const ids = jtis.filter(Boolean);
    if (!ids.length) return false;
    return !!(await RevokedToken.exists({ jti: { $in: ids } }));
};

const _verify = (token, secret, typ) => {
    if (!token || typeof token !== "string") throw zaiError(401, "ZAI_TOKEN_MISSING");
    const unverified = jwt.decode(token);
    if (!unverified || unverified.typ !== typ) throw zaiError(403, "ZAI_SCOPE_DENIED");
    try {
        return jwt.verify(token, secret);
    } catch (error) {
        throw zaiError(401, error.name === "TokenExpiredError" ? "ZAI_TOKEN_EXPIRED" : "ZAI_TOKEN_INVALID");
    }
};

const verifyIdentityToken = async (token) => {
    if (!isIdentityEnabled()) throw zaiError(503, "ZAI_DISABLED");
    const claims = _verify(token, identitySecret(), "identity");
    if (await isRevoked([claims.jti])) throw zaiError(403, "ZAI_TOKEN_REVOKED");
    return claims;
};

/** Exchange a valid identity token for a short-lived zAI token (no new proof). */
const exchangeForZaiToken = async (identityToken) => {
    if (!isZaiEnabled()) throw zaiError(503, "ZAI_DISABLED");
    const identity = await verifyIdentityToken(identityToken);
    const ttl = Math.max(1, Math.min(ZAI_TTL_SECONDS, identity.exp - Math.floor(Date.now() / 1000)));
    const jti = crypto.randomUUID();
    const token = jwt.sign(
        { typ: "zai", sub: identity.sub, zid: identity.zid, addr: identity.addr, scope: ["zai:chat"], parent_jti: identity.jti, jti },
        zaiSecret(),
        {
            expiresIn: ttl,
        }
    );
    return { zaiToken: token, expiresAt: Math.floor(Date.now() / 1000) + ttl, zelfName: identity.sub };
};

const verifyZaiToken = async (token, scope = "zai:chat") => {
    if (!isZaiEnabled()) throw zaiError(503, "ZAI_DISABLED");
    const claims = _verify(token, zaiSecret(), "zai");
    if (!Array.isArray(claims.scope) || !claims.scope.includes(scope)) throw zaiError(403, "ZAI_SCOPE_DENIED");
    if (await isRevoked([claims.jti, claims.parent_jti])) throw zaiError(403, "ZAI_TOKEN_REVOKED");
    return claims;
};

/** Revoke an identity token (and, via parent_jti, every zAI token derived from it). Idempotent. */
const revokeIdentityToken = async (identityToken) => {
    if (!isIdentityEnabled()) throw zaiError(503, "ZAI_DISABLED");
    let claims;
    try {
        claims = jwt.verify(identityToken, identitySecret(), { ignoreExpiration: true });
    } catch (_) {
        throw zaiError(401, "ZAI_TOKEN_INVALID");
    }
    if (claims.typ !== "identity") throw zaiError(403, "ZAI_SCOPE_DENIED");
    const expiresAt = new Date(Math.max(claims.exp * 1000, Date.now() + 60 * 1000));
    await RevokedToken.updateOne(
        { jti: claims.jti },
        { $setOnInsert: { jti: claims.jti, typ: "identity", sub: claims.sub, expiresAt } },
        { upsert: true }
    );
    return { revoked: true, jti: claims.jti };
};

/** Public view of the verified zAI identity (for GET /api/zai/me). */
const getZaiIdentity = (zai) => ({ zelfName: zai.zelfName, zid: zai.zid, addresses: zai.addresses });

/** Shape stored in ctx.state.zai by the guard middleware. */
const toZaiState = (claims) => ({
    zelfName: claims.sub,
    zid: claims.zid,
    addresses: claims.addr || {},
    jti: claims.jti,
    parentJti: claims.parent_jti,
});

module.exports = {
    zaiError,
    getZaiIdentity,
    toZaiState,
    IDENTITY_TTL_SECONDS,
    ZAI_TTL_SECONDS,
    isIdentityEnabled,
    isZaiEnabled,
    issueIdentityToken,
    attachIdentityToken,
    verifyIdentityToken,
    exchangeForZaiToken,
    verifyZaiToken,
    revokeIdentityToken,
    _internal: { fullName, recordId, addressesOf },
};
