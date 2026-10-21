require("dotenv").config();
const FormData = require("form-data");
const axios = require("axios");

const pinataEnv = process.env.PINATA_ENV || process.env.IPFS_ENV || process.env.NODE_ENV || "development";
const prefix = pinataEnv === "development" ? "_" : "";
const pinataGateway =
    process.env[`${prefix}PINATA_GATEWAY_URL`] ||
    process.env.PINATA_GATEWAY_URL ||
    process.env.__PINATA_GATEWAY_URL ||
    process.env["2_PINATA_GATEWAY_URL"];
const pinataJwt =
    process.env[`${prefix}PINATA_JWT`] ||
    process.env.PINATA_JWT ||
    process.env.__PINATA_JWT ||
    process.env["2_PINATA_JWT"];
const os = process.env.ENVOS;

/**
 * Rewrite any Pinata dedicated-gateway URL to use the current configured gateway.
 * This prevents image/metadata URLs baked into IPFS JSON at upload time (potentially
 * under a different Pinata account/gateway) from breaking in production.
 *
 * Handles:
 *  - *.mypinata.cloud dedicated gateway URLs
 *  - Our custom domain (ipfs.zelf.world) — in case it also needs normalising
 *
 * @param {string} url - URL to normalise
 * @returns {string} - URL with the current pinataGateway substituted in, or the original if not a Pinata URL
 */
const rewriteGatewayUrl = (url) => {
    if (!url || typeof url !== "string" || !pinataGateway) return url;
    // Match either *.mypinata.cloud or ipfs.zelf.world dedicated gateway patterns
    const m = url.match(/https?:\/\/(?:[^/]+\.mypinata\.cloud|ipfs\.zelf\.world)\/ipfs\/([^/?#]+)/);
    if (!m) return url;
    return `https://${pinataGateway}/ipfs/${m[1]}`;
};

const pinataWeb3 = require("pinata");

/**
 * Helper function to format metadata keyvalues for Pinata API
 * Converts simple key:value pairs to Pinata's expected format
 * @param {Object} metadata - Simple key:value metadata object
 * @returns {Object} - Formatted metadata for Pinata
 *
 * NOTE: Currently not used because we're using Pinata API v1 for uploads
 * which expects simple key:value pairs. This function is ready for when
 * we switch to the new Pinata SDK v2+ which expects complex format.
 */
const formatMetadataForPinata = (metadata) => {
    if (!metadata || typeof metadata !== "object") {
        return {};
    }

    const formattedKeyvalues = {};

    Object.entries(metadata).forEach(([key, value]) => {
        // If value is already in Pinata format, use it as-is
        if (typeof value === "object" && value !== null && "value" in value && "op" in value) {
            formattedKeyvalues[key] = value;
        } else {
            // Convert simple key:value to Pinata format
            formattedKeyvalues[key] = {
                value: String(value),
                op: "eq", // Default to equality operation
            };
        }
    });

    return formattedKeyvalues;
};

/**
 * Helper function to parse metadata keyvalues from Pinata API response
 * Converts Pinata's format back to simple key:value pairs for easier use
 * @param {Object} keyvalues - Pinata formatted keyvalues object
 * @returns {Object} - Simple key:value metadata object
 */
const parseMetadataFromPinata = (keyvalues) => {
    if (!keyvalues || typeof keyvalues !== "object") {
        return {};
    }

    const simpleMetadata = {};

    Object.entries(keyvalues).forEach(([key, value]) => {
        // If value is in Pinata format, extract the actual value
        if (typeof value === "object" && value !== null && "value" in value) {
            simpleMetadata[key] = value.value;
        } else {
            // If it's already a simple value, use it as-is
            simpleMetadata[key] = value;
        }
    });

    return simpleMetadata;
};

/**
 * Helper function to normalize Pinata API response keys
 * Handles inconsistent casing in Pinata SDK responses (e.g., Keyvalues vs keyvalues, IpfsHash vs ipfsHash)
 * Normalizes all properties to camelCase format
 * 			- Specifically when using `pinFileWindows`
 * @param {Object} response - Pinata API response object
 * @returns {Object} - Normalized response with consistent key casing
 */
const normalizePinataResponse = (response) => {
    if (!response || typeof response !== "object") return response;

    const keyMapping = {
        GroupId: "groupId",
        ID: "id",
        IpfsHash: "ipfsHash",
        Keyvalues: "keyvalues",
        MimeType: "mimeType",
        Name: "name",
        NumberOfFiles: "numberOfFiles",
        PinSize: "pinSize",
        Timestamp: "timestamp",
    };

    const normalized = { ...response };

    Object.keys(keyMapping).forEach((oldKey) => {
        const newKey = keyMapping[oldKey];

        if (oldKey in normalized && !(newKey in normalized)) {
            normalized[newKey] = normalized[oldKey];

            delete normalized[oldKey];
        }
    });

    if (normalized.metadata && typeof normalized.metadata === "object") {
        if ("Keyvalues" in normalized.metadata && !("keyvalues" in normalized.metadata)) {
            normalized.metadata.keyvalues = normalized.metadata.Keyvalues;

            delete normalized.metadata.Keyvalues;
        }
    }

    return normalized;
};

// Use JWT authentication for new SDK v2.5.0
const web3Instance = new pinataWeb3.PinataSDK({
    pinataJwt,
    pinataGateway,
});

const upload = async (base64Image, filename = "image.png", mimeType = "image/png", metadata = {}) => {
    if (base64Image == null || typeof base64Image !== "string" || base64Image.trim() === "") {
        const err = new Error("ipfs_upload_missing_base64");
        err.status = 400;
        throw err;
    }

    try {
        // Use the new Pinata SDK v2.5.0 with JWT authentication
        const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, "");

        const uploadResponse = await web3Instance.upload.public.base64(base64Data).name(filename).keyvalues(metadata);

        // Normalize response keys to handle inconsistent casing (Keyvalues vs keyvalues)
        const normalizedResponse = normalizePinataResponse(uploadResponse);

        const expiresIn = 1800;

        // Create URL using the gateway
        const url = `https://${pinataGateway}/ipfs/${normalizedResponse.cid}`;

        return {
            ...normalizedResponse,
            url,
            urlExpiresIn: expiresIn,
            metadata,
        };
    } catch (error) {
        console.error("Error uploading file:", error);
    }

    return null;
};

const retrieve = async (cid, expires = 1800) => {
    if (!cid) return null;

    try {
        // Use the new Pinata SDK v2.5.0 with JWT authentication
        const pinnedFiles = await web3Instance.files.public.list().cid(cid);

        const url = await web3Instance.gateways.private.createAccessLink({
            cid,
            expires,
        });

        return { url, pinnedFiles };
    } catch (exception) {
        const error = new Error(exception.message || "file_not_found");

        error.status = exception.status || 404;

        throw error; // Rethrow to ensure higher-level code catches this.
    }
};

/**
 * pin a file into Pinata IPFS
 * @param {String} base64Image
 * @param {String} filename
 * @param {String} mimeType
 * @param {Object} metadata
 * @returns ipfs file
 */
const pinFile = async (base64Image, filename = "image.png", mimeType = "image/png", metadata = {}) => {
    if (base64Image == null || typeof base64Image !== "string" || base64Image.trim() === "") {
        const err = new Error("ipfs_pin_missing_base64");
        err.status = 400;
        throw err;
    }

    if (os === "Win") return await pinFileWindows(base64Image, filename, mimeType, metadata);

    try {
        const base64Data = base64Image.replace(/^data:[^;]+;base64,/, "");

        const uploadResponse = await web3Instance.upload.public.base64(base64Data).name(filename).keyvalues(metadata);

        const normalizedResponse = normalizePinataResponse(uploadResponse);

        return {
            cid: normalizedResponse.cid,
            ipfs_pin_hash: normalizedResponse.cid,
            ipfsHash: normalizedResponse.cid,
            name: filename,
            pinned: true,
            url: `https://${pinataGateway}/ipfs/${normalizedResponse.cid}`,
            web3: true,
            ...normalizedResponse,
        };
    } catch (error) {
        console.error("IPFS Pinning Error:", error);

        // Extract real Pinata message if available
        let errorMessage = "ipfs_pinning_failed";
        if (error.response?.data?.error?.details) {
            errorMessage = error.response.data.error.details;
        } else if (error.message) {
            errorMessage = error.message;
        }

        const pinError = new Error(errorMessage);
        pinError.status = 400;
        throw pinError;
    }
};

const pinFileWindows = async (base64Image, filename = "image.png", mimeType = "image/png", metadata = {}) => {
    if (base64Image == null || typeof base64Image !== "string" || base64Image.trim() === "") {
        const err = new Error("ipfs_pin_missing_base64");
        err.status = 400;
        throw err;
    }

    const PINATA_API_KEY =
        process.env[`${prefix}PINATA_API_KEY`] ||
        process.env.PINATA_API_KEY ||
        process.env.__PINATA_API_KEY ||
        process.env["2_PINATA_API_KEY"];
    const PINATA_SECRET_API_KEY =
        process.env[`${prefix}PINATA_API_SECRET`] ||
        process.env.PINATA_API_SECRET ||
        process.env.__PINATA_API_SECRET ||
        process.env["2_PINATA_API_SECRET"];

    try {
        const formData = new FormData();

        const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, "base64");

        formData.append("file", buffer, filename);

        if (metadata) {
            formData.append(
                "pinataMetadata",
                JSON.stringify({
                    name: filename,
                    keyvalues: metadata,
                })
            );
        }

        const response = await axios.post("https://api.pinata.cloud/pinning/pinFileToIPFS", formData, {
            headers: {
                ...formData.getHeaders(),
                pinata_api_key: PINATA_API_KEY,
                pinata_secret_api_key: PINATA_SECRET_API_KEY,
            },
        });

        const uploadResponse = response.data;

        const normalizedResponse = normalizePinataResponse(uploadResponse);

        return {
            url: `https://${pinataGateway}/ipfs/${normalizedResponse.cid}`,
            pinned: true,
            web3: true,
            name: filename,
            metadata,
            ...normalizedResponse,
        };
    } catch (error) {
        console.error(error);
        return null;
    }
};

const _normalizeFiles = (files) => {
    for (const file of files) {
        const n = normalizePinataResponse(file);
        if (n.cid && n.cid !== "pending") n.url = `https://${pinataGateway}/ipfs/${n.cid}`;
        if (n.metadata?.keyvalues) n.publicData = parseMetadataFromPinata(n.metadata.keyvalues);
        else if (n.keyvalues) {
            n.publicData = parseMetadataFromPinata(n.keyvalues);
            delete n.keyvalues;
        }
        Object.assign(file, n);
    }
    return files;
};

/**
 * Auto-paginating filter using Pinata cursor-based pagination.
 * Keeps fetching pages via next_page_token until exhausted or safety cap (1000) is hit.
 * Each page requests 100 items (Pinata max per request).
 */
const filter = async (property = "name", value, options = {}) => {
    const PAGE_SIZE = 100; // Pinata max per request
    const SAFETY_CAP = options.limit || 1000;
    const allFiles = [];

    try {
        let pageToken = null;

        while (allFiles.length < SAFETY_CAP) {
            let query;
            if (property === "name") query = web3Instance.files.public.list().name(value);
            else if (property === "cid") query = web3Instance.files.public.list().cid(value);
            else query = web3Instance.files.public.list().keyvalues({ [property]: value });

            query = query.limit(PAGE_SIZE);
            if (pageToken && typeof query.pageToken === "function") {
                query = query.pageToken(pageToken);
            }

            const response = await query;
            if (!Array.isArray(response?.files)) throw new Error("invalid_ipfs_search_response");
            const files = response.files;
            allFiles.push(...files);

            pageToken = response.next_page_token || null;

            // Stop if Pinata says there are no more pages, or this page was empty
            if (!pageToken || files.length === 0) break;
        }

        if (!allFiles.length) return [];
        return _normalizeFiles(allFiles);
    } catch (error) {
        // Availability checks must distinguish an empty index from a failed query.
        if (options.throwOnError) throw error;
        console.error("Error filtering files:", error);
        return [];
    }
};

const unPinFiles = async (CIDs = []) => {
    return await web3Instance.unpin(CIDs);
};

const deleteFiles = async (ids = []) => {
    if (!Array.isArray(ids)) {
        ids = [ids];
    }

    const unpin = await web3Instance.files.public.delete(ids);

    return unpin;
};

/**
 * Get a single pinned file's metadata by its Pinata file ID.
 */
const getFileById = async (id) => {
    try {
        const file = await web3Instance.files.public.get(id);

        if (!file) throw new Error(`404:file_not_found:${id}`);

        const normalized = normalizePinataResponse(file);

        if (normalized.metadata?.keyvalues) {
            normalized.publicData = parseMetadataFromPinata(normalized.metadata.keyvalues);
        } else if (normalized.keyvalues) {
            normalized.publicData = parseMetadataFromPinata(normalized.keyvalues);
        }
        if (normalized.cid) {
            normalized.url = `https://${pinataGateway}/ipfs/${normalized.cid}`;
        } else if (normalized.ipfsHash) {
            normalized.url = `https://${pinataGateway}/ipfs/${normalized.ipfsHash}`;
        }
        return normalized;
    } catch (e) {
        throw new Error(`404:file_not_found:${id}`);
    }
};

/**
 * Update Pinata keyvalues for an existing pin WITHOUT changing the IPFS CID.
 * Uses web3Instance.files.public.update() (Pinata SDK v2.5+).
 * Falls back to delete-and-re-pin if the SDK method is unavailable.
 *
 * This is the preferred approach: CID stays the same, no re-pin latency.
 * getItem() surfaces keyvalues to top-level, so tokenId is visible to the frontend.
 *
 * @param {string} id         Pinata file ID
 * @param {object} keyvalues  Plain key→value pairs to merge into existing metadata
 * @returns {{ id, cid, url, method: 'update' }}
 */
const updateFileKeyvalues = async (id, keyvalues) => {
    // Pinata SDK v2.5: files.public.update({ id, keyvalues })
    // Docs: https://docs.pinata.cloud/sdk/files/public/update
    const result = await web3Instance.files.public.update({ id, keyvalues });

    const normalized = normalizePinataResponse(result);
    return {
        ...normalized,
        url: normalized.cid ? `https://${pinataGateway}/ipfs/${normalized.cid}` : null,
        method: "update",
    };
};

/**
 * Convenience wrapper: update a minted NFT's tokenId in Pinata keyvalues.
 * Uses the SDK update — no re-pin, no CID change, no file ID change.
 */
const updateItemTokenId = async (ipfsFileId, tokenId, txHash) => {
    const result = await updateFileKeyvalues(ipfsFileId, {
        tokenId: String(tokenId),
        mintTxHash: txHash || "",
    });
    return result;
};

/**
 * Fetch a single page of files filtered by a keyvalue property.
 * Returns { files: normalizedFiles[], nextPageToken: string|null }.
 * Use this when you need cursor-based pagination with an external cache layer.
 *
 * @param {string} property  - Keyvalue key (e.g. "category")
 * @param {string} value     - Exact value to match
 * @param {object} options
 * @param {number} [options.pageSize=100]   - Items per page (max 100)
 * @param {string} [options.pageToken]      - Cursor from previous call
 */
const filterPaged = async (property, value, options = {}) => {
    const PAGE_SIZE = Math.min(options.pageSize || 100, 100);

    const fetchPage = async () => {
        let query;
        if (property === "name") query = web3Instance.files.public.list().name(value);
        else if (property === "cid") query = web3Instance.files.public.list().cid(value);
        else query = web3Instance.files.public.list().keyvalues({ [property]: value });

        query = query.limit(PAGE_SIZE);
        if (options.pageToken && typeof query.pageToken === "function") {
            query = query.pageToken(options.pageToken);
        }

        const response = await query;
        const files = response.files || [];
        const nextPageToken = response.next_page_token || null;
        return { files: _normalizeFiles(files), nextPageToken };
    };

    try {
        return await fetchPage();
    } catch (firstError) {
        console.error("Error in filterPaged (retrying):", firstError);
        try {
            return await fetchPage();
        } catch (secondError) {
            console.error("Error in filterPaged:", secondError);
            throw secondError;
        }
    }
};

module.exports = {
    upload,
    retrieve,
    pinFile,
    pinFileWindows,
    filter,
    filterPaged,
    unPinFiles,
    deleteFiles,
    getFileById,
    updateFileKeyvalues,
    updateItemTokenId,
    rewriteGatewayUrl,
};

