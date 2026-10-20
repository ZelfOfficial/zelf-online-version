const config = require("../../../Core/config");

/** Allowed request body keys per face `action` (server-only fields like tolerance/removePGP are excluded). */
const ALLOWED_BY_ACTION = {
    decrypt: [
        "faceBase64",
        "password",
        "securePassword",
        "tagName",
        "domain",
        "addServerPassword",
        "os",
        "captchaToken",
        "faceNonce",
        "pow",
        "zelfProof",
    ],
    lease: ["faceBase64", "tagName", "domain", "type", "os", "captchaToken", "faceNonce", "pow", "password", "mnemonic", "referralTagName", "wordsCount"],
    "lease-recovery": [
        "zelfProof",
        "tagName",
        "domain",
        "faceBase64",
        "password",
        "securePassword",
        "securityType",
        "os",
        "captchaToken",
        "faceNonce",
        "pow",
        "referralTagName",
        "duration",
    ],
    delete: ["tagName", "domain", "faceBase64", "password", "faceNonce", "pow", "cid"],
    encrypt: [
        "faceBase64",
        "metadata",
        "identifier",
        "livenessLevel",
        "os",
        "publicData",
        "password",
        "faceNonce",
        "pow",
        "zelfProof",
        "zelfProofQRCode",
    ],
    retrieve: ["faceBase64", "id", "category", "faceNonce", "pow", "keyPassword"],
    preview: ["faceBase64", "id", "category", "faceNonce", "pow"],
    "store-password": ["faceBase64", "password", "title", "url", "username", "notes", "faceNonce", "pow", "defaultProtection"],
    "store-zotp": ["faceBase64", "secret", "issuer", "account", "faceNonce", "pow"],
    "store-notes": ["faceBase64", "title", "content", "faceNonce", "pow"],
    "store-credit-card": [
        "faceBase64",
        "cardName",
        "cardNumber",
        "expiryMonth",
        "expiryYear",
        "cvv",
        "bankName",
        "faceNonce",
        "pow",
    ],
    "change-master-password": ["faceBase64", "oldMasterPassword", "newMasterPassword", "faceNonce", "pow"],
    "wallet-decrypt": ["faceBase64", "password", "os", "faceNonce", "pow"],
    "wallet-create": ["faceBase64", "password", "os", "faceNonce", "pow"],
    "wallet-import": ["faceBase64", "mnemonic", "password", "os", "faceNonce", "pow"],
    "zns-decrypt": ["faceBase64", "password", "zelfName", "domain", "os", "faceNonce", "pow"],
    "zns-lease": ["faceBase64", "zelfName", "domain", "os", "faceNonce", "pow", "password"],
    generic: ["faceBase64", "password", "securePassword", "os", "faceNonce", "pow", "tagName", "domain", "zelfProof"],
};

const pickWhitelistedBody = (body, action) => {
    if (!config.faceSecurity?.bodyWhitelist?.enabled) {
        return { body: { ...body }, rejected: [] };
    }

    const allowed = ALLOWED_BY_ACTION[action] || ALLOWED_BY_ACTION.generic;
    const allowedSet = new Set(allowed);
    const picked = {};
    const rejected = [];

    for (const [key, value] of Object.entries(body || {})) {
        if (allowedSet.has(key)) {
            picked[key] = value;
        } else {
            rejected.push(key);
        }
    }

    if (picked.securePassword && !picked.password) {
        picked.password = picked.securePassword;
    }
    delete picked.securePassword;

    if (picked.securityType === "securePassword") {
        delete picked.securityType;
    }

    return { body: picked, rejected };
};

module.exports = {
    ALLOWED_BY_ACTION,
    pickWhitelistedBody,
};
