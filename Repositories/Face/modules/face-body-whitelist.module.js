const config = require("../../../Core/config");

/**
 * Keys clients sometimes send that must never influence server behavior.
 * Removed when `FACE_BODY_WHITELIST_ENABLED` is true (default).
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

/**
 * Used only when `FACE_BODY_STRICT_WHITELIST=true`. Keep aligned with controllers/modules + extension v4 payloads.
 */
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
        "newTagName",
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
    "purchase-slot": withCommon("kind", "idempotencyKey"),
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
    "daily-reward": withCommon("tagName", "domain"),
    "wallet-decrypt": withCommon(),
    "wallet-create": withCommon(),
    "wallet-import": withCommon("mnemonic"),
    "wallet-preview": withCommon("zelfProof", "tagName", "domain"),
    "zns-decrypt": withCommon("password", "zelfName", "domain"),
    "zns-lease": withCommon("password", "zelfName", "domain"),
    "my-tags-transfer": withCommon("tagName", "domain", "newOwnerEmail", "transferMessage", "password"),
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
    generic: withCommon("tagName", "newTagName", "domain", "zelfProof", "identifier", "securityType", "id", "zelfName"),
};

const applyLegacyFieldMappings = (body) => {
    const picked = { ...body };

    if (picked.securePassword && !picked.password) {
        picked.password = picked.securePassword;
    }
    delete picked.securePassword;

    if (picked.securityType === "securePassword") {
        delete picked.securityType;
    }

    if ((!picked.tagName || picked.tagName === "") && picked.newTagName) {
        picked.tagName = picked.newTagName;
    }

    return picked;
};

const stripServerOnlyFields = (body) => {
    const picked = { ...(body || {}) };
    const strippedServerOnly = [];

    for (const key of STRIPPED_SERVER_ONLY_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(picked, key)) {
            strippedServerOnly.push(key);
            delete picked[key];
        }
    }

    return { picked, strippedServerOnly };
};

const pickWhitelistedBody = (body, action) => {
    const input = body || {};

    if (!config.faceSecurity?.bodyWhitelist?.enabled) {
        return {
            body: applyLegacyFieldMappings({ ...input }),
            rejected: [],
            strippedServerOnly: [],
            strictWouldReject: [],
        };
    }

    const { picked: afterServerStrip, strippedServerOnly } = stripServerOnlyFields(input);
    let picked = applyLegacyFieldMappings(afterServerStrip);

    const strict = config.faceSecurity?.bodyWhitelist?.strict === true;
    const allowed = ALLOWED_BY_ACTION[action] || ALLOWED_BY_ACTION.generic;
    const allowedSet = new Set(allowed);

    const strictWouldReject = Object.keys(picked).filter((key) => !allowedSet.has(key));

    if (strict) {
        const filtered = {};
        const rejected = [];
        for (const [key, value] of Object.entries(picked)) {
            if (allowedSet.has(key)) {
                filtered[key] = value;
            } else {
                rejected.push(key);
            }
        }
        picked = filtered;
        return { body: picked, rejected, strippedServerOnly, strictWouldReject: [] };
    }

    if (strictWouldReject.length) {
        console.info("[face-security] strict whitelist would drop keys (FACE_BODY_STRICT_WHITELIST=false)", {
            action,
            keys: strictWouldReject,
        });
    }

    return { body: picked, rejected: [], strippedServerOnly, strictWouldReject };
};

module.exports = {
    ALLOWED_BY_ACTION,
    STRIPPED_SERVER_ONLY_FIELDS,
    pickWhitelistedBody,
    applyLegacyFieldMappings,
};
