/**
 * ZelfKey Module - Password Manager functionality similar to LastPass
 * Standalone version without external dependencies
 * @author Miguel Trevino <miguel@zelf.world>
 */
const TagsModule = require("../../Tags/modules/tags.module");
const TagsPartsModule = require("../../Tags/modules/tags-parts.module");
const ZelfKeyIPFSModule = require("./zelf-key-ipfs.module");
const ZelfProofModule = require("../../ZelfProof/modules/zelf-proof.module");
const WalrusModule = require("../../Walrus/modules/walrus.module");
const IPFS = require("../../../Core/ipfs");
const QRZelfProofExtractor = require("../../Tags/modules/qr-zelfproof-extractor.module");
const PGPKeyModule = require("../../PGP/modules/pgp-keys.module");
const {
    isWalrusStorageSupported,
    isIPFSStorageSupported,
} = require("../../Tags/config/supported-domains");
const { createNFT } = require("../../Avalanche/modules/avax-nft.module");
const { resolveEncryptVersion } = require("../../Tags/modules/tags-addresses.module");

const config = require("../../../Core/config");
const { errorHandler } = require("../../../Core/http-handler");
const { validate } = require("../../../Core/JoiUtils");
const {
    BULK_PASSWORDS_MAX,
    PROTECTION_FACE,
    PROTECTION_FACE_PASSWORD,
    passwordCredentialSchema,
} = require("../middlewares/zelf-key.middleware");

const TYPES_REQUIRING_TRANSPORT_ENCRYPTION = new Set(["password", "notes", "note", "credit_card", "payment-card"]);
const SUPPORTED_CATEGORIES = ["password", "notes", "credit_card", "contact", "zotp"];

const normalizeOptionalString = (value) => {
    const trimmed = typeof value === "string" ? value.trim() : "";
    return trimmed || undefined;
};

const compactPublicData = (publicData) => {
    const next = {};

    for (const [key, value] of Object.entries(publicData || {})) {
        if (value === undefined || value === "") continue;
        next[key] = value;
    }

    return next;
};

const withFolderMetadata = (publicData, folder) =>
    compactPublicData({
        ...publicData,
        folder,
    });

/**
 * Resolve protection for a key. Legacy keys without `publicData.protection` default to
 * `face` because v4 ZelfKeys were encrypted without a proof password layer.
 * @param {string|undefined} value
 * @returns {"face"|"face_password"}
 */
const resolveProtection = (value) => {
    if (value === PROTECTION_FACE_PASSWORD) return PROTECTION_FACE_PASSWORD;
    return PROTECTION_FACE;
};

const protectionRequiresKeyPassword = (protection) => protection === PROTECTION_FACE_PASSWORD;

const protectionFromPreview = (preview) => {
    const storedProtection = preview?.publicData?.protection;

    if (storedProtection === PROTECTION_FACE_PASSWORD || storedProtection === PROTECTION_FACE) {
        return resolveProtection(storedProtection);
    }

    const layerRequiresPassword = ZelfProofModule.passwordLayerRequiresPassword(preview?.passwordLayer);

    if (layerRequiresPassword === true) return PROTECTION_FACE_PASSWORD;
    if (layerRequiresPassword === false) return PROTECTION_FACE;

    return null;
};

/**
 * Resolve retrieve protection from the stored proof. Request fields are only a fallback
 * when preview cannot read protection (e.g. upstream preview unavailable).
 * @param {Object} data retrieve request body
 * @returns {Promise<"face"|"face_password">}
 */
const resolveRetrieveProtection = async (data) => {
    const requestHint = data.publicData?.protection ?? data.protection;

    if (!data.zelfProof) {
        return resolveProtection(requestHint);
    }

    try {
        const version = resolveEncryptVersion({
            v: data.v,
            zelfEncryptVersion: data.zelfEncryptVersion,
            encryptVersion: data.encryptVersion,
            ...(data.publicData && typeof data.publicData === "object" ? data.publicData : {}),
        });

        const preview =
            version === 4
                ? await ZelfProofModule.preview({ zelfProof: data.zelfProof, stack: "v4" })
                : await ZelfProofModule.previewWithLegacyFallback({ zelfProof: data.zelfProof });

        const fromStored = protectionFromPreview(preview);

        if (fromStored) return fromStored;
    } catch (error) {
        console.warn("resolveRetrieveProtection preview failed; falling back to request hint", error?.message);
    }

    return resolveProtection(requestHint);
};

const assertProtectionStoreRules = (protection, keyPassword) => {
    if (protectionRequiresKeyPassword(protection) && !keyPassword) {
        throw new Error("409:master_password_required_for_face_password_protection");
    }
};

const stampV4PublicData = (publicData) =>
    compactPublicData({
        ...publicData,
        v: "4",
    });

const createMetadataAndPublicData = async (type, data, authToken) => {
    const identifier = authToken.tagName || authToken.identifier;

    const fullTagName = `${identifier}${authToken.domain ? "." + authToken.domain : ""}`;
    const protection = resolveProtection(data.protection);

    const typePayload = {
        metadata: {},
        publicData: {},
        fullTagName,
        protection,
    };

    switch (type) {
        case "zotp":
            typePayload.metadata = {
                setupKey: `${data.setupKey}`,
                username: `${data.username}`,
            };

            typePayload.publicData = withFolderMetadata(
                {
                    category: `${fullTagName}_zotp`,
                    issuer: `${data.issuer}`,
                    keyOwner: fullTagName,
                    protection,
                    type,
                    username: `${data.username}`,
                },
                normalizeOptionalString(data.folder),
            );

            break;
        case "password":
            typePayload.metadata = {
                password: `${data.password}`,
                username: `${data.username}`,
                // Notes are private: keep them inside the encrypted metadata (CSV "extra").
                ...(normalizeOptionalString(data.notes) ? { notes: `${data.notes}` } : {}),
            };

            typePayload.publicData = withFolderMetadata(
                {
                    alias: normalizeOptionalString(data.alias),
                    category: `${fullTagName}_password`,
                    keyOwner: fullTagName,
                    protection,
                    timestamp: `${new Date().toISOString()}`,
                    type,
                    username: data.username,
                    website: `${data.website}`,
                },
                normalizeOptionalString(data.folder),
            );

            break;
        case "notes":
            typePayload.metadata = data.keyValuePairs;

            typePayload.publicData = withFolderMetadata(
                {
                    category: `${fullTagName}_notes`,
                    keyOwner: fullTagName,
                    protection,
                    timestamp: `${new Date().toISOString()}`,
                    title: `${data.title}`,
                    type,
                },
                normalizeOptionalString(data.folder),
            );

            break;
        case "credit_card":
            typePayload.metadata = {
                cardNumber: `${data.cardNumber}`,
                cvv: `${data.cvv}`,
                expiryMonth: `${data.expiryMonth}`,
                expiryYear: `${data.expiryYear}`,
            };

            typePayload.publicData = withFolderMetadata(
                {
                    alias: normalizeOptionalString(data.alias),
                    card: JSON.stringify({
                        bankName: `${data.bankName}`,
                        expires: `${data.expiryMonth}/${data.expiryYear.slice(-2)}`,
                        name: `${data.cardName}`,
                        number: `****-****-****-${data.cardNumber.slice(-4)}`,
                    }),
                    category: `${fullTagName}_credit_card`,
                    keyOwner: fullTagName,
                    protection,
                    timestamp: `${new Date().toISOString()}`,
                    type,
                },
                normalizeOptionalString(data.folder),
            );

            break;
        default:
            throw new Error(`Unsupported data type: ${type}`);
    }

    typePayload.publicData = stampV4PublicData(typePayload.publicData);

    return typePayload;
};

const _store = async (publicData, metadata, faceBase64, identifier, authToken, type, keyPassword) => {
    const zelfKey = {
        zelfProof: null,
        zelfProofQRCode: null,
    };

    const protection = resolveProtection(publicData?.protection);
    assertProtectionStoreRules(protection, keyPassword);

    const dataToEncrypt = {
        _id: identifier,
        addServerPassword: false,
        faceBase64,
        metadata,
        publicData,
        password: protectionRequiresKeyPassword(protection) ? keyPassword : undefined,
        tolerance: "REGULAR",
        stack: "v4",
    };

    const { zelfProof } = await ZelfProofModule.encrypt(dataToEncrypt);
    zelfKey.zelfProof = zelfProof;
    zelfKey.zelfProofQRCode = await QRZelfProofExtractor.generateQRFromZelfProof(zelfProof);

    // Store ZOTP in Walrus
    if (isWalrusStorageSupported(authToken.domain, "zelfkeys")) {
        zelfKey.walrus = await WalrusModule.zelfKeyStorage(zelfKey.zelfProofQRCode, {
            zelfProof: zelfKey.zelfProof,
            publicData,
        });
    }

    // now save it in IPFS
    if (isIPFSStorageSupported(authToken.domain, "zelfkeys")) {
        zelfKey.ipfs = await ZelfKeyIPFSModule.saveZelfKey(
            {
                zelfProofQRCode: zelfKey.zelfProofQRCode,
                identifier,
                publicData: { ...publicData, walrus: zelfKey.walrus?.blobId },
            },
            authToken,
        );
    }

    // Pin QR code separately for NFT (using the same image)
    let qrCodeIPFS = null;

    try {
        qrCodeIPFS = await IPFS.pinFile(zelfKey.zelfProofQRCode, `${identifier}.png`, "image/png", {
            ...publicData,
            identifier,
        });
    } catch (ipfsError) {
        console.warn("⚠️ Failed to pin QR code to IPFS, continuing without IPFS:", ipfsError.message);
    }

    let NFT = null;

    try {
        NFT =
            config.avalanche.createNFT && qrCodeIPFS
                ? await createNFT(
                    {
                        identifier,
                        publicData,
                        url: qrCodeIPFS.url,
                        zelfProof: zelfKey.zelfProof,
                        zelfQR: zelfKey.zelfProofQRCode,
                    },
                    authToken,
                )
                : null;

        if (NFT) {
            const NFTJSON = JSON.stringify(NFT, null, 2);

            const base64Data = Buffer.from(NFTJSON).toString("base64");
            const base64Json = `data:application/json;base64,${base64Data}`;

            await IPFS.pinFile(base64Json, `${identifier}_nft_transaction.json`, "application/json", {
                category: `${publicData.category}_nft_transaction`,
                explorerUrl: NFT.explorerUrl,
                identifier,
                metadata: JSON.stringify(NFT.metadata),
                transactionHash: NFT.transactionHash,
                receipt: JSON.stringify({
                    contractAddress: NFT.contractAddress,
                    cost: NFT.cost,
                    metadataUrl: NFT.metadataUrl,
                    owner: NFT.owner,
                    tokenId: NFT.tokenId,
                }),
            });
        }
    } catch (ipfsError) {
        console.warn("⚠️ Failed to pin NFT transaction to IPFS, continuing without IPFS:", ipfsError.message);
    }

    return {
        ...zelfKey,
        NFT,
    };
};

/**
 * Store website passwords
 * @param {Object} data
 * @param {string} data.website - Website URL or name
 * @param {string} data.username - Username/email for the site
 * @param {string} data.password - Password for the site
 * @param {string} data.notes - Additional notes
 * @param {string} data.faceBase64 - User's face for encryption
 * @param {string} data.password - User's master password
 * @returns {Promise<Object>}
 */
// Helper function to generate short timestamp (e.g., H2M0)
const getShortTimestamp = () => {
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();

    return `H${hours}M${minutes}`;
};

/**
 * Main function to handle different types of data storage
 * @param {Object} data
 * @param {string} data.type - Type of data to store (password, notes, credit_card)
 * @param {Object} data.payload - Data payload specific to the type
 * @param {string} data.faceBase64 - User's face for encryption
 * @param {string} data.password - User's master password
 * @returns {Promise<Object>}
 */
const storeData = async (data, authToken) => {
    try {
        const { type, domain } = data;

        const decryptedParams = await TagsPartsModule.decryptParams(
            {
                password: data.masterPassword,
                faceBase64: data.faceBase64,
                removePGP: data.removePGP,
            },
            authToken,
        );

        let decryptedSensitiveData = {};

        switch (type) {
            case "credit_card":
                decryptedSensitiveData = await TagsPartsModule.decryptCreditCardParams(data, authToken);

                if (!_isValidCreditCard(decryptedSensitiveData.cardNumber)) {
                    throw new Error("409:invalid_credit_card_number");
                }

                break;
            case "password":
                decryptedSensitiveData = await TagsPartsModule.decryptPasswordParams(data, authToken);

                break;
            case "notes":
                decryptedSensitiveData = await TagsPartsModule.decryptNotesParams(data, authToken);

                break;
            default:
                break;
        }

        const faceBase64 = decryptedParams.face;

        await _validateOwnership(data.faceBase64, data.masterPassword, authToken, data);

        const { metadata, publicData, fullTagName, protection } = await createMetadataAndPublicData(
            type,
            { ...data, faceBase64, ...decryptedSensitiveData },
            authToken,
        );

        assertProtectionStoreRules(protection, decryptedParams.password);

        const shortTimestamp = getShortTimestamp();

        const identifier = `${fullTagName}_${shortTimestamp}`;

        const result = await _store(
            publicData,
            metadata,
            faceBase64,
            identifier,
            authToken,
            type,
            decryptedParams.password,
        );

        return {
            ...result,
            type,
            message: "Data stored successfully",
        };
    } catch (error) {
        console.error("Error in storeData:", error);
        throw error;
    }
};

const formatStoreError = (error) => {
    const handled = errorHandler(error);

    return {
        message: handled.message,
        code: handled.code,
    };
};

const _storePasswordRecord = async (itemData, authToken, sharedContext, identifierSuffix = "") => {
    const { faceBase64, face, removePGP, keyPassword, defaultProtection } = sharedContext;

    const decryptedSensitiveData = await TagsPartsModule.decryptPasswordParams(
        { ...itemData, removePGP },
        authToken,
    );

    const { metadata, publicData, fullTagName, protection } = await createMetadataAndPublicData(
        "password",
        {
            ...itemData,
            faceBase64,
            face,
            protection: itemData.protection ?? defaultProtection,
            ...decryptedSensitiveData,
        },
        authToken,
    );

    assertProtectionStoreRules(protection, keyPassword);

    const shortTimestamp = getShortTimestamp();
    const identifier = `${fullTagName}_${shortTimestamp}${identifierSuffix ? `_${identifierSuffix}` : ""}`;

    const result = await _store(publicData, metadata, face, identifier, authToken, "password", keyPassword);

    return {
        ...result,
        type: "password",
        message: "Data stored successfully",
    };
};

/**
 * Bulk import website passwords with a single face + masterPassword verification.
 * @param {Object} data
 * @param {string} data.faceBase64
 * @param {string} [data.masterPassword]
 * @param {boolean} [data.removePGP]
 * @param {Array<Object>} data.passwords - Per-credential fields (website, username, password, etc.)
 * @param {Object} authToken
 * @returns {Promise<Object>}
 */
const storePasswordsBulk = async (data, authToken) => {
    const { faceBase64, masterPassword, removePGP, passwords } = data;

    const decryptedParams = await TagsPartsModule.decryptParams(
        {
            password: masterPassword,
            faceBase64,
            removePGP,
        },
        authToken,
    );

    await _validateOwnership(faceBase64, masterPassword, authToken, data);

    const batchProtection = resolveProtection(data.protection);
    assertProtectionStoreRules(batchProtection, decryptedParams.password);

    const sharedContext = {
        faceBase64,
        face: decryptedParams.face,
        removePGP,
        keyPassword: decryptedParams.password,
        defaultProtection: data.protection,
    };

    const success = [];
    const failed = [];
    // Two batches sent in the same minute would otherwise reuse `${tag}_H{h}M{m}_${index}`.
    const batchTag = Date.now().toString(36);

    for (let index = 0; index < passwords.length; index++) {
        const item = passwords[index];
        const valid = validate(passwordCredentialSchema, item);

        if (valid.error) {
            failed.push({
                index,
                message: valid.error.message.trim(),
                code: "ValidationError",
            });
            continue;
        }

        try {
            const stored = await _storePasswordRecord(item, authToken, sharedContext, `${batchTag}_${index}`);
            success.push({
                index,
                ...stored,
            });
        } catch (error) {
            failed.push({
                index,
                ...formatStoreError(error),
            });
        }
    }

    return {
        success,
        failed,
        total: passwords.length,
        successCount: success.length,
        failedCount: failed.length,
        maxBatchSize: BULK_PASSWORDS_MAX,
    };
};

/**
 * Retrieve stored data using ZelfProof
 * @param {Object} data
 * @param {string} data.zelfProof - Encrypted ZelfProof
 * @param {string} data.faceBase64 - User's face for decryption
 * @param {string} [data.password] - Optional ZelfProof password
 * @param {string} data.clientPublicKey - Client ephemeral public key for transport encryption
 * @param {string} [data.type] - Record type (password, notes, credit_card, ...)
 * @returns {Promise<Object>}
 */
const retrieveData = async (data, authToken) => {
    const { zelfProof, faceBase64, password, type, clientPublicKey } = data;

    let decryptedParams = null;
    let pgp = null;
    let zelfKey = null;

    const protection = await resolveRetrieveProtection(data);

    decryptedParams = await TagsPartsModule.decryptParams(
        {
            password,
            faceBase64,
            removePGP: data.removePGP,
        },
        authToken,
    );

    if (protectionRequiresKeyPassword(protection)) {
        if (!decryptedParams.password) {
            throw new Error("400:ERR_MISSING_PASSWORD");
        }
    } else {
        decryptedParams.password = undefined;
    }

    try {
        const version = resolveEncryptVersion({
            v: data.v,
            zelfEncryptVersion: data.zelfEncryptVersion,
            encryptVersion: data.encryptVersion,
            ...(data.publicData && typeof data.publicData === "object" ? data.publicData : {}),
        });

        zelfKey = await ZelfProofModule.decrypt({
            faceBase64: decryptedParams.face,
            os: "DESKTOP",
            password: decryptedParams.password,
            zelfProof,
            ...(version === 4 ? { stack: "v4" } : {}),
        });
    } catch (error) {
        console.error({ error });

        if (typeof error?.code === "string" && error.code.startsWith("ERR_")) {
            const status =
                Number.isFinite(error.status) && error.status >= 400 && error.status < 600 ? error.status : 422;

            throw new Error(`${status}:${error.code}`);
        }

        if (error?.message && typeof error.message === "string") {
            const normalizedMessage = error.message.toLowerCase();

            if (normalizedMessage.includes("password") && normalizedMessage.includes("invalid")) {
                throw new Error("400:ERR_INVALID_PASSWORD");
            }

            if (
                normalizedMessage.includes("liveness") ||
                normalizedMessage.includes("face is not central") ||
                normalizedMessage.includes("no face detected") ||
                normalizedMessage.includes("multiple face") ||
                normalizedMessage.includes("face not recognized")
            ) {
                throw new Error("422:ERR_LIVENESS_FAILED");
            }
        }

        throw new Error("409:failed_to_decrypt");
    }

    if (!zelfKey) throw new Error("409:zelf_key_record_not_found");

    const resolvedType = type || zelfKey?.publicData?.type;

    if (TYPES_REQUIRING_TRANSPORT_ENCRYPTION.has(resolvedType) && zelfKey.metadata) {
        if (!clientPublicKey) throw new Error("409:missing_client_public_key");

        try {
            pgp = await PGPKeyModule.encryptToPublicKey(zelfKey.metadata, clientPublicKey);
            zelfKey.metadata = {};
        } catch (error) {
            console.error("failed_to_encrypt_metadata_for_transport", error);
            throw new Error("409:failed_to_encrypt_metadata_for_transport");
        }
    }

    return {
        ...zelfKey,
        pgp,
    };
};

/**
 * Preview stored data without full decryption
 * @param {Object} data
 * @param {string} data.zelfProof - Encrypted ZelfProof
 * @param {string} data.faceBase64 - User's face for preview
 * @returns {Promise<Object>}
 */
const previewData = async (data, authToken) => {
    try {
        const { zelfProof, faceBase64 } = data;

        return {
            success: true,
            publicData: null,
            message: "Data preview successful",
        };
    } catch (error) {
        console.error("Error previewing data:", error);
        throw new Error("Failed to preview data");
    }
};

/**
 * Create NFT-ready data structure from ZelfKey storage
 * This function prepares the data for NFT minting with proper metadata
 * @param {Object} data
 * @param {string} data.zelfProof - Encrypted ZelfProof string
 * @param {string} data.faceBase64 - User's face for verification
 * @param {string} data.password - User's master password
 * @returns {Promise<Object>} NFT-ready data structure
 */
const createNFTReadyData = async (data, authToken) => {
    try {
        const { zelfProof, faceBase64, password } = data;

        const retrievedData = await retrieveData(
            {
                zelfProof,
                faceBase64,
                password,
            },
            authToken,
        );

        if (!retrievedData.success || !retrievedData.data.ipfs) {
            throw new Error("No IPFS data available for NFT creation");
        }

        const { ipfs, publicData } = retrievedData.data;

        // Create NFT-ready structure
        const nftReadyData = {
            success: true,
            zelfKeyData: {
                publicData,
                ipfs: {
                    hash: ipfs.hash,
                    gatewayUrl: ipfs.gatewayUrl,
                    pinSize: ipfs.pinSize,
                    timestamp: ipfs.timestamp,
                    name: ipfs.name,
                    metadata: ipfs.metadata,
                },
                message: `NFT-ready data created from ${publicData.type}`,
                timestamp: new Date().toISOString(),
            },
            nftMetadata: {
                name: `ZelfKey ${publicData.type.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())}`,
                description: `Secure ${publicData.type.replace(/_/g, " ")} stored with ZelfKey biometric encryption`,
                image: ipfs.gatewayUrl,
                external_url: "https://zelf.world",
                attributes: [
                    {
                        trait_type: "Data Type",
                        value: publicData.type.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()),
                    },
                    {
                        trait_type: "Storage Method",
                        value: "ZelfKey Biometric Encryption",
                    },
                    {
                        trait_type: "Security Level",
                        value: "Maximum",
                    },
                    {
                        trait_type: "IPFS Hash",
                        value: ipfs.hash,
                    },
                    {
                        trait_type: "Timestamp",
                        value: ipfs.timestamp,
                    },
                    {
                        trait_type: "Project",
                        value: "ZelfKey Avalanche Integration",
                    },
                ],
                properties: {
                    files: [
                        {
                            type: "image/png",
                            uri: ipfs.gatewayUrl,
                        },
                    ],
                    category: "image",
                    zelfKey: {
                        type: publicData.type,
                        encrypted: true,
                        biometric: true,
                        ipfs: {
                            hash: ipfs.hash,
                            gateway: ipfs.gatewayUrl,
                        },
                    },
                },
            },
            message: "NFT-ready data structure created successfully",
        };

        return nftReadyData;
    } catch (error) {
        console.error("Error creating NFT-ready data:", error);
        throw new Error(`Failed to create NFT-ready data: ${error.message}`);
    }
};

/**
 * List data by category
 * @param {Object} data - Query parameters
 * @param {Object} authToken - Authentication token
 * @returns {Promise<Object>} List of data items in the specified category
 */
const listData = async (data, authToken) => {
    try {
        const { category, tagName: queryTagName } = data;
        let identifier = authToken.tagName || authToken.identifier;

        // Allow tagName override only for staff or when it matches the authenticated user
        let domain = authToken.domain || "zelf";
        if (queryTagName && queryTagName.trim()) {
            const isStaff = authToken.accountType === "staff";
            const userTagName = TagsPartsModule.getFullTagName(identifier, domain);
            if (isStaff || queryTagName === userTagName) {
                const parts = queryTagName.split(".");
                identifier = parts[0] || queryTagName;
                domain = parts[1] || domain;
            }
        }
        const fullTagName = TagsPartsModule.getFullTagName(identifier, domain);

        let searchCategory = category;
        let results = [];

        searchCategory = `${fullTagName}_${category}`;

        // Search IPFS for tags where category matches
        const ipfsResults = await IPFS.filter("category", searchCategory);

        // List returns pin metadata only. The QR is decoded when one item is opened.
        if (ipfsResults && Array.isArray(ipfsResults)) {
            results = ipfsResults
                .map((item) => {
                    const publicData = item.publicData || {};

                    if (publicData.category !== searchCategory) {
                        return null;
                    }

                    return {
                        id: item.id || item.cid,
                        cid: item.cid,
                        url: item.url,
                        publicData,
                        createdAt: item.created_at || item.createdAt,
                        updatedAt: item.updated_at || item.updatedAt,
                    };
                })
                .filter(Boolean);
        }

        return {
            success: true,
            message: `Found ${results.length} items in category: ${category}`,
            category,
            data: results,
            timestamp: new Date().toISOString(),
            fullTagName,
            searchCategory,
            totalCount: results.length,
        };
    } catch (error) {
        console.error("Error listing data:", error);
        throw new Error(`Failed to list data: ${error.message}`);
    }
};

/**
 * List data for dashboard - requires identifier (user.domain), enforces staff/ownership
 * @param {string} identifier - Full tag name (e.g. miguel.zelf)
 * @param {string} [category] - Optional category filter
 * @param {Object} authToken - Authentication token
 * @returns {Promise<Object>} List of data items
 */
const listDataForDashboard = async (identifier, category, authToken) => {
    const parts = identifier.split(".");
    if (parts.length < 2) {
        throw new Error("400:Invalid identifier format. Use user.domain (e.g. miguel.zelf)");
    }
    const domainPart = parts.pop();
    const identifierPart = parts.join(".");

    const accountType = authToken.accountType || authToken.publicData?.accountType || "";
    const isPrivileged = ["staff", "staff_account", "lawyer", "lawyer_account"].includes(accountType);
    const userIdentifier = authToken.tagName || authToken.identifier;
    if (!isPrivileged && userIdentifier) {
        const userTagName = TagsPartsModule.getFullTagName(userIdentifier, authToken.domain || "zelf");
        if (identifier !== userTagName) {
            throw new Error("403:Not authorized to query ZelfKeys for this identifier");
        }
    }

    const syntheticAuthToken = { ...authToken, tagName: identifierPart, identifier: identifierPart, domain: domainPart };

    if (category) {
        return listData({ category }, syntheticAuthToken);
    }
    return listAllData({}, syntheticAuthToken);
};

/**
 * List all data for dashboard across all categories
 * @param {string} identifier - Full tag name (e.g. miguel.zelf)
 * @param {Object} authToken - Authentication token
 * @returns {Promise<Object>} Merged list of all data items by category
 */
const listAllDataForDashboard = async (identifier, authToken) => {
    const resultsByCategory = {};
    let totalCount = 0;

    for (const cat of SUPPORTED_CATEGORIES) {
        const listResult = await listDataForDashboard(identifier, cat, authToken);
        resultsByCategory[cat] = listResult.data || [];
        totalCount += (listResult.data || []).length;
    }

    return {
        success: true,
        message: `Found ${totalCount} items across all categories`,
        data: resultsByCategory,
        timestamp: new Date().toISOString(),
        totalCount,
    };
};

/**
 * List all data across all categories
 * @param {Object} data - Query parameters (optional tagName)
 * @param {Object} authToken - Authentication token
 * @returns {Promise<Object>} Merged list of all data items by category
 */
const listAllData = async (data, authToken) => {
    const resultsByCategory = {};
    let totalCount = 0;

    for (const category of SUPPORTED_CATEGORIES) {
        const listResult = await listData({ ...data, category }, authToken);
        resultsByCategory[category] = listResult.data || [];
        totalCount += (listResult.data || []).length;
    }

    return {
        success: true,
        message: `Found ${totalCount} items across all categories`,
        data: resultsByCategory,
        timestamp: new Date().toISOString(),
        totalCount,
    };
};

const deleteZelfKey = async (data, authToken) => {
    try {
        const { id, faceBase64, masterPassword } = data;

        await _validateOwnership(faceBase64, masterPassword, authToken, data);

        const result = await IPFS.deleteFiles([id]);

        return {
            result,
            success: true,
            message: "ZelfKey deleted successfully",
        };
    } catch (error) {
        if (error?.message && typeof error.message === "string") {
            const normalizedMessage = error.message.toLowerCase();

            if (normalizedMessage.includes("password") && normalizedMessage.includes("invalid")) {
                throw new Error("400:ERR_INVALID_PASSWORD");
            }

            if (normalizedMessage.includes("liveness") || normalizedMessage.includes("face")) {
                throw new Error("400:ERR_LIVENESS_FAILED");
            }
        }

        throw error;
    }
};

const _validateOwnership = async (faceBase64, masterPassword, authToken, extraParams) => {
    const sessionParams = {
        domain: authToken.domain,
        faceBase64,
        password: masterPassword,
        tagName: authToken.tagName || authToken.identifier,
        removePGP: extraParams.removePGP || false,
    };

    // this will throw an error if the tag is not found or the password is incorrect or the face is incorrect
    await TagsModule.decryptTag(sessionParams, authToken);
};

/**
 * Luhn algorithm for credit card validation
 * @param {string} cardNumber - Credit card number to validate
 * @returns {boolean} - True if valid, false otherwise
 */
const _isValidCreditCard = (cardNumber) => {
    // Remove spaces and dashes
    const cleanNumber = cardNumber.replace(/\s+/g, "").replace(/-/g, "");

    // Check if it's all digits
    if (!/^\d+$/.test(cleanNumber)) {
        return false;
    }

    let sum = 0;
    let isEven = false;

    // Loop through values starting from the rightmost side
    for (let i = cleanNumber.length - 1; i >= 0; i--) {
        let digit = parseInt(cleanNumber.charAt(i));

        if (isEven) {
            digit *= 2;
            if (digit > 9) {
                digit -= 9;
            }
        }

        sum += digit;
        isEven = !isEven;
    }

    return sum % 10 === 0;
};

const _ownsZelfKey = (publicData, fullTagName) => {
    const keyOwner = publicData?.keyOwner || "";
    const category = publicData?.category || "";

    if (keyOwner === fullTagName) return true;

    return SUPPORTED_CATEGORIES.some((name) => category === `${fullTagName}_${name}`);
};

/**
 * Decode one pinned QR for an item the authenticated tag owns.
 * The list endpoint does not download QRs.
 * @param {{ id: string }} data
 * @param {Object} authToken
 */
const getProof = async (data, authToken) => {
    const identifier = authToken.tagName || authToken.identifier;
    const domain = authToken.domain || "zelf";
    const fullTagName = TagsPartsModule.getFullTagName(identifier, domain);

    let item;

    try {
        item = await IPFS.getFileById(data.id);
    } catch (error) {
        throw new Error("404:ZelfKey not found");
    }

    const publicData = item.publicData || {};

    if (!_ownsZelfKey(publicData, fullTagName)) {
        throw new Error("403:Not authorized to read this ZelfKey");
    }

    if (!item.url) {
        throw new Error("404:ZelfKey not found");
    }

    const zelfProofQRCode = await TagsPartsModule.urlToBase64(item.url);

    if (!zelfProofQRCode) {
        throw new Error("400:Failed to read ZelfKey QR");
    }

    const zelfProof = await QRZelfProofExtractor.extractZelfProofFromQR(zelfProofQRCode);

    if (!zelfProof) {
        throw new Error("400:Failed to extract ZelfProof");
    }

    return {
        id: item.id || data.id,
        cid: item.cid,
        zelfProof,
        zelfProofQRCode,
    };
};

const _listOwnedKeyItems = async (authToken) => {
    const identifier = authToken.tagName || authToken.identifier;
    const domain = authToken.domain || "zelf";
    const fullTagName = TagsPartsModule.getFullTagName(identifier, domain);
    const items = [];

    for (const category of SUPPORTED_CATEGORIES) {
        const searchCategory = `${fullTagName}_${category}`;
        const ipfsResults = await IPFS.filter("category", searchCategory);

        if (!Array.isArray(ipfsResults)) continue;

        for (const row of ipfsResults) {
            const publicData = row.publicData || {};

            if (publicData.category !== searchCategory) continue;
            if (!_ownsZelfKey(publicData, fullTagName)) continue;

            items.push({
                id: row.id || row.cid,
                cid: row.cid,
                name: row.name,
                url: row.url,
                publicData,
                category,
            });
        }
    }

    return items;
};

const _extractZelfProofFromItem = async (item) => {
    if (!item?.url) throw new Error("404:ZelfKey not found");

    const zelfProofQRCode = await TagsPartsModule.urlToBase64(item.url);

    if (!zelfProofQRCode) throw new Error("400:Failed to read ZelfKey QR");

    const zelfProof = await QRZelfProofExtractor.extractZelfProofFromQR(zelfProofQRCode);

    if (!zelfProof) throw new Error("400:Failed to extract ZelfProof");

    return { zelfProof, zelfProofQRCode };
};

const _prepareKeyReencrypt = async (item, faceBase64, oldPassword, newPassword) => {
    const { zelfProof } = await _extractZelfProofFromItem(item);

    const decrypted = await ZelfProofModule.decrypt({
        faceBase64,
        os: "DESKTOP",
        password: oldPassword,
        zelfProof,
        stack: "v4",
    });

    const publicData = stampV4PublicData({
        ...(decrypted.publicData || item.publicData || {}),
        protection: PROTECTION_FACE_PASSWORD,
    });

    const identifier = item.name || item.publicData?.timestamp || item.id;

    const { zelfProof: nextProof } = await ZelfProofModule.encrypt({
        _id: identifier,
        addServerPassword: false,
        faceBase64,
        metadata: decrypted.metadata,
        publicData,
        password: newPassword,
        tolerance: "REGULAR",
        stack: "v4",
    });

    const zelfProofQRCode = await QRZelfProofExtractor.generateQRFromZelfProof(nextProof);

    return {
        oldId: item.id,
        filename: item.name || identifier,
        publicData,
        zelfProof: nextProof,
        zelfProofQRCode,
    };
};

/**
 * Re-encrypt every `face_password` key with a new master password.
 * Atomic: preparation and pinning must all succeed, or no IPFS records are replaced.
 * @param {Object} data
 * @param {string} data.faceBase64
 * @param {string} data.oldMasterPassword
 * @param {string} data.newMasterPassword
 * @param {boolean} [data.removePGP]
 * @param {Object} authToken
 * @returns {Promise<Object>}
 */
const changeMasterPassword = async (data, authToken) => {
    const { faceBase64, oldMasterPassword, newMasterPassword, removePGP } = data;

    const oldDecrypted = await TagsPartsModule.decryptParams(
        {
            password: oldMasterPassword,
            faceBase64,
            removePGP,
        },
        authToken,
    );

    const { password: newPassword } = await TagsPartsModule.decryptParams(
        {
            password: newMasterPassword,
            removePGP,
        },
        authToken,
    );

    if (!oldDecrypted.password) {
        throw new Error("409:old_master_password_required");
    }

    if (!newPassword) {
        throw new Error("409:new_master_password_required");
    }

    if (oldDecrypted.password === newPassword) {
        throw new Error("409:new_master_password_must_differ");
    }

    await _validateOwnership(faceBase64, oldMasterPassword, authToken, data);

    const ownedItems = await _listOwnedKeyItems(authToken);
    const targets = ownedItems.filter(
        (item) => resolveProtection(item.publicData?.protection) === PROTECTION_FACE_PASSWORD,
    );

    if (!targets.length) {
        return {
            success: true,
            message: "No face_password keys to update",
            updatedCount: 0,
            skippedCount: ownedItems.length,
            updated: [],
        };
    }

    const prepared = [];

    for (const item of targets) {
        try {
            const payload = await _prepareKeyReencrypt(
                item,
                oldDecrypted.face,
                oldDecrypted.password,
                newPassword,
            );
            prepared.push({ item, payload });
        } catch (error) {
            console.error("changeMasterPassword prepare failed", { id: item.id, error });
            throw new Error("409:failed_to_prepare_master_password_change");
        }
    }

    const pinned = [];

    try {
        for (const entry of prepared) {
            const pin = await IPFS.pinFile(
                entry.payload.zelfProofQRCode,
                entry.payload.filename,
                null,
                entry.payload.publicData,
            );

            pinned.push({
                oldId: entry.item.id,
                newId: pin.id || pin.ID,
            });
        }

        await IPFS.deleteFiles(prepared.map((entry) => entry.item.id));
    } catch (error) {
        if (pinned.length) {
            const rollbackIds = pinned.map((entry) => entry.newId).filter(Boolean);
            if (rollbackIds.length) {
                try {
                    await IPFS.deleteFiles(rollbackIds);
                } catch (rollbackError) {
                    console.error("changeMasterPassword rollback failed", rollbackError);
                }
            }
        }

        console.error("changeMasterPassword apply failed", error);
        throw new Error("409:failed_to_apply_master_password_change");
    }

    return {
        success: true,
        message: "Master password updated for face_password keys",
        updatedCount: prepared.length,
        skippedCount: ownedItems.length - prepared.length,
        updated: prepared.map((entry) => ({
            id: entry.item.id,
            category: entry.item.category,
            protection: PROTECTION_FACE_PASSWORD,
            publicData: entry.payload.publicData,
        })),
    };
};

const summarizeData = async (_data, authToken) => {
    const identifier = authToken.tagName || authToken.identifier;
    const domain = authToken.domain || "zelf";
    const fullTagName = TagsPartsModule.getFullTagName(identifier, domain);
    const counts = {
        password: 0,
        credit_card: 0,
        notes: 0,
        contact: 0,
        zotp: 0,
    };

    await Promise.all(
        SUPPORTED_CATEGORIES.map(async (category) => {
            const searchCategory = `${fullTagName}_${category}`;
            const ipfsResults = await IPFS.filter("category", searchCategory);
            const matched = Array.isArray(ipfsResults)
                ? ipfsResults.filter((item) => (item.publicData || {}).category === searchCategory)
                : [];
            counts[category] = matched.length;
        }),
    );

    return {
        totalCount: Object.values(counts).reduce((sum, count) => sum + count, 0),
        counts,
    };
};

module.exports = {
    storeData,
    storePasswordsBulk,
    retrieveData,
    previewData,
    createNFTReadyData,
    listData,
    getProof,
    listAllData,
    listDataForDashboard,
    listAllDataForDashboard,
    summarizeData,
    deleteZelfKey,
    changeMasterPassword,
    resolveProtection,
    resolveRetrieveProtection,
    protectionRequiresKeyPassword,
};
