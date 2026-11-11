const canonicalTagName = (tagName, domain) => {
    const raw = String(tagName || "").trim().toLowerCase();
    if (!raw) return "";
    if (raw.includes(".")) return raw;
    const normalizedDomain = String(domain || "zelf").trim().toLowerCase();
    return normalizedDomain ? `${raw}.${normalizedDomain}` : raw;
};

const codedError = (code, status) => {
    const error = new Error(code);
    error.status = status;
    error.code = code;
    return error;
};

/**
 * The rewarded name comes from the stored verified tag, never from the request body.
 * A client-supplied name is accepted only when it is the same name already stored.
 * `verifiedTagName` is null when the session has no unexpired stamp from the stored record.
 */
const assertRewardOwnedByVerifiedSession = (verifiedTagName, requestedTagName, requestedDomain) => {
    if (typeof verifiedTagName !== "string" || !verifiedTagName.trim()) {
        throw codedError("FACE_VERIFIED_TAG_REQUIRED", 403);
    }

    const verified = canonicalTagName(verifiedTagName);
    const requested = canonicalTagName(requestedTagName, requestedDomain);

    if (!verified || (requested && requested !== verified)) {
        throw codedError("TAG_OWNER_MISMATCH", 403);
    }

    return verified;
};

const splitCanonicalTag = (canonical) => {
    const value = canonicalTagName(canonical);
    const parts = value.split(".");
    const domain = parts.length > 1 ? parts.pop() : "zelf";
    const name = parts.join(".") || value;
    return { name, domain, canonical: value };
};

/**
 * One claim per tag name. A recorded payout or an in-progress claim blocks another payout.
 * A failed claim with no payout can be retried.
 */
const firstTransactionClaimDecision = (existing) => {
    if (!existing) return "create";
    if (existing.payoutTx || existing.status === "claimed" || existing.status === "pending") return "already";
    if (existing.status === "failed" && !existing.payoutTx) return "retry";
    return "already";
};

module.exports = {
    assertRewardOwnedByVerifiedSession,
    splitCanonicalTag,
    firstTransactionClaimDecision,
};
