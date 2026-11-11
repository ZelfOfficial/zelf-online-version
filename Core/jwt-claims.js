const jwt = require("jsonwebtoken");

const STRIPPED_CLAIMS = ["superAdminId", "staffId", "typ"];

const TOKEN_TYPES = {
    session: "session",
    client: "client",
    staff: "staff",
    lawyer: "lawyer",
    superAdmin: "super_admin",
    duration: "duration",
    quote: "quote",
    record: "record",
    purchase: "purchase",
    priceLock: "price_lock",
    staffInvitation: "staff_invitation",
    lawyerInvitation: "lawyer_invitation",
    vaultLegacy: "vault_legacy",
};

const signToken = (payload, secret, options = {}) => {
    if (!options.typ || typeof options.typ !== "string") {
        throw new Error("JWT_TYP_REQUIRED");
    }

    const claims = { ...(payload || {}) };

    for (const key of STRIPPED_CLAIMS) {
        delete claims[key];
    }

    claims.typ = options.typ;

    if (options.superAdminId) {
        claims.superAdminId = options.superAdminId;
    }

    if (options.staffId) {
        claims.staffId = options.staffId;
    }

    const signOptions = {};

    if (options.expiresIn != null && claims.exp == null) {
        signOptions.expiresIn = options.expiresIn;
    }

    if (options.algorithm) {
        signOptions.algorithm = options.algorithm;
    }

    return jwt.sign(claims, secret, signOptions);
};

const bearerFromHeader = (header) => {
    if (!header || typeof header !== "string") return null;
    const value = header.trim();
    if (!value) return null;

    const ey = value.indexOf("ey");
    if (ey !== -1) return value.substring(ey);

    const parts = value.split(" ");
    return parts.length > 1 ? parts[1] : value;
};

module.exports = {
    STRIPPED_CLAIMS,
    TOKEN_TYPES,
    signToken,
    bearerFromHeader,
};
