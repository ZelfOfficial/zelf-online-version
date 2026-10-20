const config = require("../../../Core/config");

/**
 * Keys clients sometimes send that must never influence server behavior.
 * They are removed silently when present (not forwarded to modules/controllers).
 */
const STRIPPED_SERVER_ONLY_FIELDS = [
    "removePGP",
    "tolerance",
    "requireLiveness",
    "liveness_tolerance",
    "livenessDetectionPriorCreation",
    "check_live_face_before_creation",
    "verifierKey",
    "referenceFaceBase64",
    "hasPassword",
    "require_live_face",
];

const COMMON = [
    "faceBase64",
    "faceNonce",
    "pow",
    "password",
    "securePassword",
    "os",
    "masterPassword",
    "captchaToken",
];

const withCommon = (...fields) => [...new Set([...COMMON, ...fields])];

/** Allowed request body keys per face `action`. */
const ALLOWED_BY_ACTION = {
    decrypt: withCommon("tagName", "domain", "addServerPassword", "zelfProof", "securityType", "mnemonic"),
    lease: withCommon(
        "tagName",
        "domain",
        "type",
        "password",
        "mnemonic",
        "referralTagName",
        "wordsCount",
        "addServerPassword",
        "securityType"
    ),
    "lease-recovery": withCommon(
        "zelfProof",
        "tagName",
        "domain",
        "securityType",
        "referralTagName",
        "duration",
        "addServerPassword"
    ),
    delete: withCommon("tagName", "domain", "cid", "id"),
    encrypt: withCommon(
        "metadata",
        "identifier",
        "publicData",
        "zelfProof",
        "zelfProofQRCode",
        "password",
        "livenessLevel"
    ),
    upgrade: withCommon("zelfProof", "password"),
    retrieve: withCommon(
        "zelfProof",
        "id",
        "category",
        "masterPassword",
        "clientPublicKey",
        "type",
        "v",
        "publicData",
        "protection"
    ),
    preview: withCommon("zelfProof", "id", "category"),
    "store-password": withCommon(
        "alias",
        "website",
        "username",
        "folder",
        "insideFolder",
        "notes",
        "protection",
        "defaultProtection"
    ),
    "store-passwords-bulk": withCommon("passwords", "protection"),
    "store-zotp": withCommon("username", "setupKey", "issuer", "folder", "insideFolder", "protection"),
    "store-notes": withCommon("title", "keyValuePairs", "folder", "insideFolder", "protection"),
    "store-credit-card": withCommon(
        "alias",
        "cardName",
        "cardNumber",
        "expiryMonth",
        "expiryYear",
        "cvv",
        "bankName",
        "folder",
        "insideFolder",
        "protection"
    ),
    "change-master-password": withCommon("oldMasterPassword", "newMasterPassword"),
    "wallet-decrypt": withCommon(),
    "wallet-create": withCommon(),
    "wallet-import": withCommon("mnemonic"),
    "wallet-preview": withCommon("zelfProof", "tagName", "domain"),
    "zns-decrypt": withCommon("password", "zelfName", "domain"),
    "zns-lease": withCommon("password", "zelfName", "domain"),
    "my-tags-transfer": withCommon("tagName", "domain"),
    "my-tags-extend": withCommon("tagName", "domain", "duration"),
    "my-zns-transfer": withCommon("zelfName", "password"),
    "staff-face": withCommon(
        "staffEmail",
        "staffPhone",
        "staffName",
        "role",
        "invitationToken",
        "email",
        "isResend",
        "staffPhoto",
        "staffCountryCode",
        "phone"
    ),
    "lawyer-face": withCommon(
        "lawyerEmail",
        "lawyerPhone",
        "lawyerCountryCode",
        "lawyerName",
        "domain",
        "invitationToken",
        "email",
        "name",
        "phone",
        "countryCode",
        "specialization",
        "education",
        "location",
        "bio",
        "hourlyRate",
        "licenseNumber",
        "professionalId",
        "zelfName",
        "contactEmail"
    ),
    "client-face": withCommon(
        "name",
        "countryCode",
        "phone",
        "email",
        "language",
        "company",
        "identificationMethod",
        "newPassword",
        "confirmPassword"
    ),
    "license-create": withCommon("domain", "logoBase64", "domainConfig"),
    "license-delete": withCommon(),
    "license-theme": withCommon("themeSettings"),
    "solana-payment": withCommon("amount"),
    "blockdag-zelf": withCommon(
        "proof",
        "signature",
        "message",
        "name",
        "symbol",
        "description",
        "coverImage",
        "avatarImage",
        "contractAddress",
        "owner",
        "maxSupply",
        "royaltyBps",
        "chainId",
        "createdAt",
        "walletType",
        "category",
        "image",
        "attributes",
        "collectionAddress",
        "recipientAddress",
        "tokenURI",
        "tokenId",
        "txHash",
        "traits"
    ),
    generic: withCommon("tagName", "domain", "zelfProof", "identifier", "securityType", "id", "zelfName"),
};

const pickWhitelistedBody = (body, action) => {
    if (!config.faceSecurity?.bodyWhitelist?.enabled) {
        return { body: { ...body }, rejected: [], strippedServerOnly: [] };
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

    const strippedServerOnly = rejected.filter((k) => STRIPPED_SERVER_ONLY_FIELDS.includes(k));

    if (picked.securePassword && !picked.password) {
        picked.password = picked.securePassword;
    }
    delete picked.securePassword;

    if (picked.securityType === "securePassword") {
        delete picked.securityType;
    }

    return { body: picked, rejected, strippedServerOnly };
};

module.exports = {
    ALLOWED_BY_ACTION,
    STRIPPED_SERVER_ONLY_FIELDS,
    pickWhitelistedBody,
};
