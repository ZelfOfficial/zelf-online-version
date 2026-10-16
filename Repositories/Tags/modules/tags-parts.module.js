const { decrypt, encrypt, preview, encryptQRCode } = require("../../ZelfProof/modules/zelf-proof.module");
const { generateQRFromZelfProof, extractZelfProofFromQR } = require("./qr-zelfproof-extractor.module");
const { generateStorageKey, generateHoldDomain } = require("./domain-registry.module");
const config = require("../../../Core/config");
const { getDomainConfig } = require("../config/supported-domains");
const SessionModule = require("../../Session/modules/session.module");

/**
 * Tags Parts Module
 *
 * This module handles domain-specific operations for the Tags system.
 * It provides utilities for encryption, decryption, and domain-specific data processing.
 */

/**
 * Decrypt parameters for tag operations
 * @param {Object} params - Parameters to decrypt
 * @param {Object} authUser - Authenticated user
 * @returns {Object} - Decrypted parameters
 */
const decryptParams = async (params, authUser) => {
    // One rule per field, whatever removePGP says: armored PGP -> session-decrypt, anything else is plaintext.
    const [password, mnemonic, face] = await Promise.all([
        SessionModule.decryptIfPGP(params.password, authUser),
        SessionModule.decryptIfPGP(params.mnemonic, authUser),
        SessionModule.decryptIfPGP(params.faceBase64, authUser),
    ]);

    return { password, mnemonic, face };
};

/**
 * Encrypt parameters for tag operations
 * @param {Object} params - Parameters to encrypt
 * @param {Object} authUser - Authenticated user
 * @returns {Object} - Encrypted parameters
 */
const encryptParams = async (params, authUser) => {
    const { faceBase64, password, metadata, tagName, domain } = params;

    // Get domain configuration
    const domainConfig = getDomainConfig(domain);

    if (!domainConfig) {
        throw new Error(`Domain '${domain}' is not supported`);
    }

    // Encrypt data
    const encryptedResult = await encrypt({
        faceBase64,
        password,
        metadata,
        verifierKey: config.zelfEncrypt.serverKey,
    });

    if (encryptedResult.error) {
        const error = new Error(encryptedResult.error.code);
        error.status = 409;
        throw error;
    }

    return {
        zelfProof: encryptedResult.zelfProof,
        zelfProofQRCode: encryptedResult.zelfProofQRCode,
        tagName,
        domain,
        domainConfig,
    };
};

/**
 * Preview tag data
 * @param {Object} params - Preview parameters
 * @param {Object} authUser - Authenticated user
 * @returns {Object} - Preview result
 */
const previewTag = async (params, authUser) => {
    const { zelfProof, tagName, domain } = params;

    // Get domain configuration
    const domainConfig = getDomainConfig(domain);

    if (!domainConfig) {
        throw new Error(`Domain '${domain}' is not supported`);
    }

    // Preview the data
    const previewResult = await preview({
        zelfProof,
        verifierKey: config.zelfEncrypt.serverKey,
    });

    return {
        preview: previewResult,
        tagName,
        domain,
        domainConfig,
    };
};

/**
 * Generate QR code for tag
 * @param {Object} params - QR code parameters
 * @param {Object} authUser - Authenticated user
 * @returns {Object} - QR code result
 */
const generateQRCode = async (params, authUser) => {
    const { zelfProof, tagName, domain } = params;

    // Get domain configuration
    const domainConfig = getDomainConfig(domain);

    if (!domainConfig) {
        throw new Error(`Domain '${domain}' is not supported`);
    }

    // Generate QR code
    const qrCodeResult = await encryptQRCode({
        zelfProof,
        verifierKey: config.zelfEncrypt.serverKey,
    });

    return {
        qrCode: qrCodeResult,
        tagName,
        domain,
        domainConfig,
    };
};

/**
 * Convert URL to base64
 * @param {string} url - URL to convert
 * @returns {Promise<string>} - Base64 encoded data
 */
const urlToBase64 = async (url) => {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(3500) });

        if (!response.ok) {
            console.warn(`urlToBase64: HTTP ${response.status} for ${url}`);
            return null;
        }

        const contentType = response.headers.get("content-type") || "";

        if (
            !contentType.startsWith("image/png") &&
            !contentType.startsWith("image/jpeg") &&
            !contentType.startsWith("application/octet-stream")
        ) {
            console.warn(`urlToBase64: expected image/png or image/jpeg, got ${contentType} for ${url}`);
            return null;
        }

        const buffer = await response.arrayBuffer();
        const base64 = Buffer.from(buffer).toString("base64");
        const outputMimeType = contentType.startsWith("image/jpeg") ? "image/jpeg" : "image/png";
        return `data:${outputMimeType};base64,${base64}`;
    } catch (error) {
        console.error("Error converting URL to base64:", error);
        return null;
    }
};

/**
 * Try each URL in order; return first successful data URL from urlToBase64.
 * @param {Array<string|undefined|null>} urls
 * @returns {Promise<string|null>}
 */
const urlToBase64First = async (urls) => {
    const seen = new Set();
    for (const raw of urls) {
        const u = typeof raw === "string" ? raw.trim() : "";
        if (!u || seen.has(u)) continue;
        seen.add(u);
        const b64 = await urlToBase64(u);
        if (b64) return b64;
    }
    return null;
};

/**
 * Generate domain-specific hold domain
 * @param {string} domain - Domain name
 * @param {string} name - Tag name
 * @returns {string} - Hold domain name
 */
const generateDomainHoldDomain = (domain, name) => {
    return generateHoldDomain(domain, name);
};

/**
 * Validate domain-specific data
 * @param {Object} data - Data to validate
 * @param {string} domain - Domain name
 * @returns {Object} - Validation result
 */
const validateDomainData = (data, domain) => {
    // Get domain configuration
    const domainConfig = getDomainConfig(domain);

    if (!domainConfig) {
        return { valid: false, error: `Domain '${domain}' is not supported` };
    }

    // Check required fields
    const requiredFields = ["tagName", "domain", "publicData", "privateData"];
    for (const field of requiredFields) {
        if (!data[field]) {
            return { valid: false, error: `Missing required field: ${field}` };
        }
    }

    // Check domain-specific validation
    if (data.domain !== domain) {
        return { valid: false, error: "Domain mismatch" };
    }

    // Check tag name format
    const tagNameParts = data.tagName.split(".");
    if (tagNameParts.length < 2 || tagNameParts[tagNameParts.length - 1] !== domain) {
        return { valid: false, error: "Invalid tag name format" };
    }

    return { valid: true };
};

/**
 * Process domain-specific metadata
 * @param {Object} metadata - Metadata to process
 * @param {string} domain - Domain name
 * @returns {Object} - Processed metadata
 */
const processDomainMetadata = (metadata, domain) => {
    // Get domain configuration
    const domainConfig = getDomainConfig(domain);

    if (!domainConfig) {
        throw new Error(`Domain '${domain}' is not supported`);
    }

    // Generate domain-specific storage key
    const storageKey = generateStorageKey(domain, metadata.tagName);

    // Process metadata with domain-specific information
    const processedMetadata = {
        ...metadata,
        storageKey,
        domain,
        domainConfig: domainConfig.type,
        timestamp: new Date().toISOString(),
        version: "1.0.0",
    };

    // Add domain-specific features
    if (domainConfig.features) {
        processedMetadata.features = domainConfig.features;
    }

    // Add domain-specific limits
    if (domainConfig.limits) {
        processedMetadata.limits = domainConfig.limits;
    }

    // Add domain-specific payment info
    if (domainConfig.payment) {
        processedMetadata.payment = domainConfig.payment;
    }

    return processedMetadata;
};

/**
 * Create domain-specific tag object
 * @param {Object} params - Tag parameters
 * @param {string} params.tagName - Tag name
 * @param {string} params.domain - Domain name
 * @param {Object} params.publicData - Public data
 * @param {Object} params.privateData - Private data
 * @param {Object} authUser - Authenticated user
 * @returns {Object} - Tag object
 */
const createTagObject = async (params, authUser) => {
    const { tagName, domain, publicData, privateData } = params;

    // Get domain configuration
    const domainConfig = getDomainConfig(domain);

    if (!domainConfig) {
        throw new Error(`Domain '${domain}' is not supported`);
    }

    // Generate domain-specific storage key
    const storageKey = generateStorageKey(domain, tagName);

    // Create tag object
    const tagObject = {
        publicData: {
            ...publicData,
            tagName: `${tagName}.${domain}`,
            domain,
            storageKey,
            domainConfig: domainConfig.type,
            timestamp: new Date().toISOString(),
        },
        privateData: {
            ...privateData,
            domain,
            storageKey,
        },
    };

    // Validate the tag object
    const validation = validateDomainData(tagObject, domain);
    if (!validation.valid) {
        throw new Error(validation.error);
    }

    return tagObject;
};

/**
 * Create domain-specific hold object
 * @param {Object} params - Hold parameters
 * @param {string} params.tagName - Tag name
 * @param {string} params.domain - Domain name
 * @param {Object} params.publicData - Public data
 * @param {Object} params.privateData - Private data
 * @param {Object} authUser - Authenticated user
 * @returns {Object} - Hold object
 */
const createHoldObject = async (params, authUser) => {
    const { tagName, domain, publicData, privateData } = params;

    // Get domain configuration
    const domainConfig = getDomainConfig(domain);
    if (!domainConfig) {
        throw new Error(`Domain '${domain}' is not supported`);
    }

    // Generate hold domain name
    const holdDomain = generateHoldDomain(domain, tagName);
    const holdStorageKey = generateStorageKey(domain, `${tagName}${domainConfig.holdSuffix}`);

    // Create hold object
    const holdObject = {
        publicData: {
            ...publicData,
            tagName: holdDomain,
            domain,
            storageKey: holdStorageKey,
            domainConfig: domainConfig.type,
            holdSuffix: domainConfig.holdSuffix,
            timestamp: new Date().toISOString(),
            status: "hold",
        },
        privateData: {
            ...privateData,
            domain,
            storageKey: holdStorageKey,
            holdSuffix: domainConfig.holdSuffix,
        },
    };

    return holdObject;
};

const assignProperties = (tagObject, dataToEncrypt, addresses, payload, domainConfig) => {
    const { referralTagObject } = payload;

    const tagKey = domainConfig.tags?.storage?.keyPrefix || "tagName";
    const referralTagName = (
        referralTagObject?.publicData?.[tagKey] ||
        referralTagObject?.publicData?.tagName ||
        referralTagObject?.publicData?.zelfName
    )?.split(".")[0];

    const { price, reward, discount, discountType } = domainConfig.getPrice(
        tagObject[tagKey] || tagObject.tagName || tagObject.zelfName,
        "1",
        referralTagName ? `${referralTagName}.${domainConfig.name}` : ""
    );

    const { eth, btc, solana, sui, stellar, arweave, polkadot, kusama, ton, aptos } = addresses;

    tagObject.price = price;
    tagObject.reward = reward;
    tagObject.discount = discount;
    tagObject.discountType = discountType;
    tagObject.ethAddress = eth.address;
    tagObject.btcAddress = btc.address;
    tagObject.solanaAddress = solana.address;
    tagObject.suiAddress = sui.address;
    tagObject.xlmAddress = stellar.address;
    tagObject.arweaveAddress = arweave.address;
    tagObject.dotAddress = polkadot?.address;
    tagObject.ksmAddress = kusama?.address;
    tagObject.tonAddress = ton?.address;
    tagObject.aptosAddress = aptos?.address;
    tagObject.hasPassword = `${Boolean(payload.password)}`;
};

const _generateZelfProof = async (dataToEncrypt, tagObject) => {
    const { zelfProof } = await encrypt(dataToEncrypt);

    tagObject.zelfProof = zelfProof;
    tagObject.zelfProofQRCode = await generateQRFromZelfProof(zelfProof);
};

const getFullTagName = (tagName, domain) => {
    if (!tagName || !domain) throw new Error(`Invalid parameters: tagName=${tagName}, domain=${domain}`);

    if (tagName.includes(`.${domain}`)) return tagName;

    return `${tagName}.${domain}`;
};

const getTagNameFromPublicData = (tagObject, type = "full", domainConfig) => {
    if (!domainConfig) domainConfig = getDomainConfig(tagObject.publicData.domain);

    const keyPrefix = domainConfig.getTagKey() || "tagName";

    switch (type) {
        case "full":
            return tagObject.publicData[keyPrefix] || tagObject.publicData.id || tagObject.publicData.tagName || tagObject.publicData.zelfName;
        case "name":
            const name = tagObject.publicData[keyPrefix] || tagObject.publicData.id || tagObject.publicData.tagName || tagObject.publicData.zelfName;
            return name ? name.split(".")[0] : "";
        default:
            return tagObject.publicData[keyPrefix] || tagObject.publicData.id || tagObject.publicData.tagName || tagObject.publicData.zelfName;
    }
};

const getWalletScopeKey = (publicData, domainConfig) => {
    if (!publicData) throw new Error("Public data is required to build wallet scope key");

    if (!domainConfig) domainConfig = getDomainConfig(publicData.domain);

    const keyPrefix = domainConfig.getTagKey() || "tagName";
    const tagName = publicData[keyPrefix] || publicData.tagName || publicData.zelfName;
    const domain = publicData.domain || domainConfig.name;

    return getFullTagName(tagName, domain);
};

const generatePGPKeys = async (dataToEncrypt, addresses, password) => {
    const { eth, solana, sui, stellar, arweave, polkadot } = addresses;

    const { mnemonic, zkProof } = dataToEncrypt.metadata;
    const domainConfig = getDomainConfig(dataToEncrypt.publicData.domain || "zelf");
    const walletScopeKey = getWalletScopeKey(dataToEncrypt.publicData, domainConfig);

    let encryptedMessage;

    let privateKey;

    const pgpKeys = await SessionModule.walletEncrypt(
        {
            mnemonic,
            zkProof,
            solanaPrivateKey: solana.secretKey,
            suiSecretKey: sui.secretKey,
            stellarSecretKey: stellar.secretKey,
            arweavePrivateKey: arweave.privateKey,
            substrateSecretKey: polkadot?.secretKey,
        },
        walletScopeKey,
        password,
        eth.address
    );

    encryptedMessage = pgpKeys.encryptedMessage;

    privateKey = pgpKeys.privateKey;

    return {
        encryptedMessage,
        privateKey,
    };
};

const decryptCreditCardParams = async (params, authUser) => {
    let { cvv, cardNumber, masterPassword } = params;

    if (params.removePGP) {
        return {
            cvv,
            cardNumber,
            masterPassword,
        };
    }

    cvv = await SessionModule.sessionDecrypt(params.cvv, authUser);
    cardNumber = params.cardNumber ? await SessionModule.sessionDecrypt(params.cardNumber, authUser) : null;
    masterPassword = params.masterPassword ? await SessionModule.sessionDecrypt(params.masterPassword, authUser) : null;

    return { cvv, cardNumber, masterPassword };
};

const decryptPasswordParams = async (params, authUser) => {
    let { password } = params;

    if (params.removePGP) {
        return {
            password,
        };
    }

    password = await SessionModule.sessionDecrypt(params.password, authUser);

    return { password };
};

const decryptNotesParams = async (params, authUser) => {
    const { keyValuePairs } = params;

    if (params.removePGP) {
        return {
            keyValuePairs,
        };
    }

    keyValuePairs.content = await SessionModule.sessionDecrypt(keyValuePairs.content, authUser);

    return { keyValuePairs };
};

const encryptCreditCardParams = async (params, authUser) => {
    const { cvv, cardNumber, masterPassword } = params;

    const pgp = await SessionModule.walletEncrypt({ cvv, cardNumber }, authUser.ethAddress, masterPassword);

    return pgp;
};

const encryptPasswordParams = async (params, authUser) => {
    const { password, masterPassword } = params;

    const pgp = await SessionModule.walletEncrypt({ password }, authUser.ethAddress, masterPassword);

    return pgp;
};

const encryptNotesParams = async (params, authUser) => {
    const { content, masterPassword } = params;

    const pgp = await SessionModule.walletEncrypt({ content }, authUser.ethAddress, masterPassword);

    return pgp;
};

module.exports = {
    decryptParams,
    encryptParams,
    previewTag,
    generateQRCode,
    urlToBase64,
    urlToBase64First,
    generateDomainHoldDomain,
    validateDomainData,
    processDomainMetadata,
    createTagObject,
    createHoldObject,
    assignProperties,
    generateZelfProof: _generateZelfProof,
    getFullTagName,
    getTagNameFromPublicData,
    getWalletScopeKey,
    generatePGPKeys,
    decryptCreditCardParams,
    decryptPasswordParams,
    decryptNotesParams,
    encryptCreditCardParams,
    encryptPasswordParams,
    encryptNotesParams,
};
