/**
 * BlockDAG NFT Module
 * Dual Wallet Support: Zelf (Biometric) & External (EVM/MetaMask)
 * Storage: IPFS (Decentralized)
 */
const IPFS = require("../../../Core/ipfs");
const ZelfProofModule = require("../../ZelfProof/modules/zelf-proof.module");
const { ethers } = require("ethers");
const config = require("../../../Core/config");
const fs = require("fs");
const OWNER_DEBUG = process.env.BLOCKDAG_NFT_OWNER_DEBUG === "1";

const ownerDebugLog = (label, payload) => {
    if (!OWNER_DEBUG) return;
    try {
        console.log(`[blockdag-nft:owner-debug] ${label}`, JSON.stringify(payload));
    } catch {
        console.log(`[blockdag-nft:owner-debug] ${label}`, payload);
    }
};

const FACTORY_ABI = [
    // V2: createCollection now takes royaltyBps
    "function createCollection(string name, string symbol, uint256 maxSupply, uint96 royaltyBps) public returns (address)",
    "event CollectionCreated(address indexed collectionAddress, string name, string symbol, address indexed owner, uint96 royaltyBps)",
];

const ERC721_ABI = [
    "function mint(address to, string uri) public returns (uint256)",
    "function ownerOf(uint256 tokenId) view returns (address)",
    "function totalSupply() view returns (uint256)",
    "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];

const OWNABLE_ABI = ["function owner() view returns (address)"];

const _normalizeAddress = (value, errorCode = "400:invalid_address") => {
    try {
        return ethers.getAddress(value);
    } catch {
        throw new Error(errorCode);
    }
};

const _getBlockDagProvider = () => {
    const rpcUrl = config.blockdag?.rpcUrl || "https://rpc.east.bdag-us.org";
    return new ethers.JsonRpcProvider(rpcUrl);
};

const _getCollectionOwnerOnChain = async (collectionAddress) => {
    const contract = new ethers.Contract(collectionAddress, OWNABLE_ABI, _getBlockDagProvider());
    const owner = await contract.owner();
    return owner ? ethers.getAddress(owner) : null;
};

const _ensureMessageIncludesCollection = (message, collectionAddress) => {
    if (!collectionAddress || collectionAddress === "none") return;
    if (typeof message !== "string" || !message.includes(`collection ${collectionAddress}`)) {
        throw new Error("400:message_collection_mismatch");
    }
};

const _findCollectionPinsByAddress = async (collectionAddress) => {
    const addrChecksum = _normalizeAddress(collectionAddress);
    const addrLower = addrChecksum.toLowerCase();
    const queries = [IPFS.filter("contractAddress", addrChecksum, { limit: 5 })];
    if (addrLower !== addrChecksum) {
        queries.push(IPFS.filter("contractAddress", addrLower, { limit: 5 }));
    }
    const all = (await Promise.all(queries)).flat();
    const seen = new Set();
    return all.filter((item) => {
        if (!item || seen.has(item.id)) return false;
        seen.add(item.id);
        return item.publicData?.category === "blockdag_nft_collection";
    });
};

const _resolveCollectionWriteAccess = async (collectionAddress, owner) => {
    if (!collectionAddress || collectionAddress === "none") {
        return {
            normalizedCollectionAddress: collectionAddress || "none",
            isDefaultCollection: false,
            onChainOwner: null,
            collectionPins: [],
        };
    }

    const normalizedCollectionAddress = _normalizeAddress(collectionAddress, "400:invalid_collection_address");
    const normalizedOwner = _normalizeAddress(owner, "400:invalid_owner_address");
    const defaultCollection = await getDefaultCollection();
    const normalizedDefault =
        defaultCollection?.address && ethers.isAddress(defaultCollection.address) ? ethers.getAddress(defaultCollection.address) : null;
    const isDefaultCollection = Boolean(normalizedDefault && normalizedCollectionAddress === normalizedDefault);

    if (isDefaultCollection) {
        return {
            normalizedCollectionAddress,
            isDefaultCollection,
            onChainOwner: normalizedDefault,
            collectionPins: [],
        };
    }

    const collectionPins = await _findCollectionPinsByAddress(normalizedCollectionAddress);
    if (collectionPins.length === 0) {
        throw new Error("404:collection_not_found");
    }

    let onChainOwner;
    try {
        onChainOwner = await _getCollectionOwnerOnChain(normalizedCollectionAddress);
    } catch (error) {
        console.error("[blockdag-nft] failed to resolve collection owner", normalizedCollectionAddress, error?.message || error);
        throw new Error("503:collection_owner_lookup_failed");
    }

    if (!onChainOwner) {
        throw new Error("404:collection_owner_not_found");
    }

    if (onChainOwner.toLowerCase() !== normalizedOwner.toLowerCase()) {
        throw new Error("403:unauthorized_collection_owner");
    }

    for (const item of collectionPins) {
        if (item.publicData?.owner !== onChainOwner) {
            IPFS.updateFileKeyvalues(item.id, { owner: onChainOwner }).catch(() => { });
        }
    }

    return {
        normalizedCollectionAddress,
        isDefaultCollection,
        onChainOwner,
        collectionPins,
    };
};

/**
 * Authorize PATCH /item/:id/token (replaceNftItemWithNewOwner).
 * Allows: default collection (any verified signer), collection owner, current token owner,
 * or previous IPFS metadata owner while chain owner already moved (seller syncing after sale).
 */
const _authorizeReplaceNftItem = async (normalizedCollectionAddr, normalizedRequester, tokenId, previousMetaOwner) => {
    if (!normalizedCollectionAddr || normalizedCollectionAddr === "none") return;

    const defaultCollection = await getDefaultCollection();
    const normalizedDefault =
        defaultCollection?.address && ethers.isAddress(defaultCollection.address) ? ethers.getAddress(defaultCollection.address) : null;
    if (normalizedDefault && normalizedCollectionAddr === normalizedDefault) return;

    let collectionOwner;
    try {
        collectionOwner = await _getCollectionOwnerOnChain(normalizedCollectionAddr);
    } catch (error) {
        console.error("[blockdag-nft] replace item: collection owner lookup failed", normalizedCollectionAddr, error?.message || error);
        throw new Error("503:collection_owner_lookup_failed");
    }
    if (!collectionOwner) throw new Error("404:collection_owner_not_found");
    if (collectionOwner.toLowerCase() === normalizedRequester.toLowerCase()) return;

    let chainTokenOwner;
    try {
        const contract = new ethers.Contract(normalizedCollectionAddr, ERC721_ABI, _getBlockDagProvider());
        chainTokenOwner = await contract.ownerOf(BigInt(tokenId));
    } catch (error) {
        console.error("[blockdag-nft] replace item: ownerOf failed", normalizedCollectionAddr, tokenId, error?.message || error);
        throw new Error("503:chain_owner_verify_failed");
    }
    if (chainTokenOwner.toLowerCase() === normalizedRequester.toLowerCase()) return;

    if (previousMetaOwner) {
        try {
            const prev = _normalizeAddress(previousMetaOwner, "400:invalid_owner_address");
            if (
                prev.toLowerCase() === normalizedRequester.toLowerCase() &&
                chainTokenOwner.toLowerCase() !== prev.toLowerCase()
            ) {
                return;
            }
        } catch {
            /* ignore invalid previous owner hint */
        }
    }

    throw new Error("403:unauthorized_collection_or_token_owner");
};

/**
 * Get the default Zelf Name Service collection address.
 * If configured via env, return immediately.
 */
const getDefaultCollection = async () => {
    const configured = config.blockdag?.defaultCollectionAddress;

    if (configured && ethers.isAddress(configured)) {
        return { address: configured, deployed: false };
    }

    return { address: null, deployed: false };
};

/**
 * Deploy the official Zelf Name Service collection via factory
 * using a server-side wallet private key (BLOCKDAG_DEPLOYER_PRIVATE_KEY).
 * Only call once and store the resulting address in BLOCKDAG_DEFAULT_COLLECTION_ADDRESS.
 */
const deployDefaultCollection = async () => {
    const pk = process.env.BLOCKDAG_DEPLOYER_PRIVATE_KEY;
    if (!pk) throw new Error("400:BLOCKDAG_DEPLOYER_PRIVATE_KEY not set");

    const provider = new ethers.JsonRpcProvider(config.blockdag.rpcUrl);
    const wallet = new ethers.Wallet(pk, provider);
    const factory = new ethers.Contract(config.blockdag.factoryAddress, FACTORY_ABI, wallet);

    const tx = await factory.createCollection("Zelf Name Service", "ZNS", BigInt(0));
    const receipt = await tx.wait();

    let newAddress = null;
    for (const log of receipt.logs) {
        try {
            const parsed = factory.interface.parseLog(log);
            if (parsed && parsed.name === "CollectionCreated") {
                newAddress = parsed.args[0];
                break;
            }
        } catch (e) {
            // ignore
        }
    }

    if (!newAddress) throw new Error("500:failed_to_extract_collection_address");

    console.log(`\n✅ Default Zelf Name Service collection deployed: ${newAddress}`);
    console.log(`   → Update your .env: BLOCKDAG_DEFAULT_COLLECTION_ADDRESS=${newAddress}\n`);

    return { address: newAddress, deployed: true };
};

/**
 * Validate authentication based on wallet type
 * @param {Object} params
 * @param {string} params.walletType - 'zelf' or 'external'
 * @param {string} params.proof - ZelfProof (if zelf)
 * @param {string} params.signature - EVM signature (if external)
 * @param {string} params.message - Original message signed (if external)
 * @param {string} params.ownerAddress - Expected owner address
 * @param {string} params.faceBase64 - Face biometric (if zelf)
 * @param {string} params.password - Password (if zelf)
 */
const _validateAuth = async (params) => {
    const { walletType, proof, signature, message, owner, faceBase64, password } = params;

    if (!signature || !message) throw new Error("400:missing_signature_data");

    // Verify EVM signature
    const recoveredAddress = ethers.verifyMessage(message, signature);

    if (recoveredAddress.toLowerCase() !== owner.toLowerCase()) throw new Error("401:signature_mismatch");

    return { verified: true, address: recoveredAddress };

    // if (walletType === "zelf") {
    //     if (!proof || !faceBase64) throw new Error("400:missing_zelf_proof_data");

    //     // Verify ZelfProof by attempting to decrypt it
    //     // If decryption works, the proof is valid and belongs to the user
    //     const decrypted = await ZelfProofModule.decrypt({
    //         faceBase64,
    //         password, // Optional depending on setup
    //         zelfProof: proof,
    //         os: "WEB", // Assumed context
    //     });

    //     if (!decrypted || decrypted.error) {
    //         throw new Error("401:invalid_zelf_proof");
    //     }

    //     // Return decrypted metadata in case we need it
    //     return decrypted;
    // } else if (walletType === "external") {
    //     if (!signature || !message) throw new Error("400:missing_signature_data");

    //     // Verify EVM signature
    //     const recoveredAddress = ethers.verifyMessage(message, signature);

    //     if (recoveredAddress.toLowerCase() !== owner.toLowerCase()) throw new Error("401:signature_mismatch");

    //     return { verified: true, address: recoveredAddress };
    // } else {
    //     throw new Error("400:invalid_wallet_type");
    // }
};

/**
 * Store Collection Metadata to IPFS
 * @param {Object} data
 * @param {Object} authdUser
 */
const storeCollection = async (data, authdUser) => {
    const {
        name,
        symbol,
        description,
        coverImage,
        avatarImage,
        contractAddress,
        maxSupply,
        royaltyBps,
        walletType,
        proof,
        signature,
        message,
        owner,
        faceBase64,
        password,
        category,
    } = data;

    // 1. Validate Auth
    await _validateAuth({ walletType, proof, signature, message, owner, faceBase64, password });

    // 2. Prepare Metadata
    const normalizedOwner = _normalizeAddress(owner, "400:invalid_owner_address");
    const normalizedContractAddress = contractAddress ? _normalizeAddress(contractAddress, "400:invalid_collection_address") : "";

    const collectionData = {
        name,
        symbol,
        description,
        coverImage,
        avatarImage,
        contractAddress: normalizedContractAddress,
        maxSupply,
        royaltyBps,
        owner: normalizedOwner,
        createdAt: new Date().toISOString(),
        verified: false, // Default
        walletType,
        category,
    };

    // 3. Pin to IPFS
    const fileName = `collection_${name.replace(/\s+/g, "_")}_${Date.now()}.json`;

    // Pinata allows max 9 keyvalues per pin. Only filterable fields; display content lives in JSON body.
    const ipfsMetadata = {
        category: "blockdag_nft_collection",
        owner: normalizedOwner,
        contractAddress: normalizedContractAddress,
        name: name,
        symbol: symbol,
        walletType: walletType,
        collectionCategory: category || "Art",
    };

    const base64Data = Buffer.from(JSON.stringify(collectionData)).toString("base64");
    const base64Json = `data:application/json;base64,${base64Data}`;
    const ipfsResult = await IPFS.pinFile(base64Json, fileName, "application/json", ipfsMetadata);

    return {
        success: true,
        ipfs: ipfsResult,
        collection: collectionData,
    };
};

/**
 * Delete a Collection from IPFS
 * @param {string} id - IPFS Hash / Pinata ID
 * @param {Object} authdUser - The full auth payload { walletType, owner, signature, message, etc }
 */
const deleteCollection = async (id, authdUser) => {
    // 1. Fetch existing IPFS metadata payload to discover true owner
    const existingFile = await IPFS.getFileById(id);

    if (!existingFile || !existingFile.publicData) throw new Error("404:collection_not_found");

    const { owner: actualOwner } = existingFile.publicData;

    if (!actualOwner) throw new Error("400:collection_owner_undefined");
    if (!authdUser) throw new Error("400:missing_auth_payload_body_empty");

    // 2. Mathematically verify the user holds the private key to the requested `owner` address
    await _validateAuth(authdUser);

    // 3. Prevent malicious signatures from other users
    if (actualOwner.toLowerCase() !== authdUser.owner.toLowerCase()) throw new Error("403:unauthorized");

    // 4. Message binding: signed message must authorize the exact id being deleted (prevents signature reuse)
    const collMatch = authdUser.message.match(/^I authorize deleting collection (.+?)\. Timestamp: \d+$/);
    if (!collMatch || collMatch[1] !== id) throw new Error("400:message_id_mismatch");

    // 5. Securely unpin file
    const result = await IPFS.deleteFiles([id]);
    return { success: true, result };
};

/**
 * Delete an NFT item from IPFS (owner-only).
 * Use for orphaned drafts (uploaded but mint failed) to remove duplicates.
 * @param {string} id - IPFS file ID / Pinata ID
 * @param {Object} authdUser - { walletType, owner, signature, message } or Zelf proof
 */
const deleteItem = async (id, authdUser) => {
    const existingFile = await IPFS.getFileById(id);
    if (!existingFile || !existingFile.publicData) throw new Error("404:item_not_found");

    const { owner: actualOwner } = existingFile.publicData;
    if (!actualOwner) throw new Error("400:item_owner_undefined");
    if (!authdUser) throw new Error("400:missing_auth_payload_body_empty");

    await _validateAuth(authdUser);
    if (actualOwner.toLowerCase() !== authdUser.owner.toLowerCase()) throw new Error("403:unauthorized");

    // Message binding: signed message must authorize the exact id being deleted (prevents signature reuse)
    const itemMatch = authdUser.message.match(/^I authorize deleting NFT metadata (.+?) from IPFS\. Timestamp: \d+$/);
    if (!itemMatch || itemMatch[1] !== id) throw new Error("400:message_id_mismatch");

    // Minted items: require on-chain owner to match signer (Pinata owner can lag after a sale)
    const pd = existingFile.publicData || {};
    const collectionAddr = (pd.collection || existingFile.collection || "").trim();
    const rawTokenId = pd.tokenId != null && pd.tokenId !== "" ? String(pd.tokenId).trim() : "";
    const hasMintedContext =
        rawTokenId !== "" && collectionAddr && collectionAddr.toLowerCase() !== "none";

    if (hasMintedContext) {
        try {
            const rpcUrl = config.blockdag?.rpcUrl || "https://rpc.east.bdag-us.org";
            const provider = new ethers.JsonRpcProvider(rpcUrl);
            const contract = new ethers.Contract(collectionAddr, ERC721_ABI, provider);
            const chainOwner = await contract.ownerOf(BigInt(rawTokenId));
            if (!chainOwner || chainOwner.toLowerCase() !== authdUser.owner.toLowerCase()) {
                throw new Error("403:unauthorized_not_chain_owner");
            }
        } catch (e) {
            if (e && typeof e.message === "string" && e.message.startsWith("403:")) {
                throw e;
            }
            console.error("[deleteItem] ownerOf verify failed", e && e.message);
            throw new Error("503:chain_owner_verify_failed");
        }
    }

    const result = await IPFS.deleteFiles([id]);
    return { success: true, result };
};

/**
 * Update Collection coverImage, avatarImage, and/or name.
 * Owner-only. Verifies signature, then delete+repin with merged metadata.
 * @param {string} id - Pinata file ID
 * @param {Object} updates - { coverImage?, avatarImage?, name? }
 * @param {Object} authdUser - { walletType, owner, signature, message } or Zelf proof
 */
const updateCollection = async (id, updates, authdUser) => {
    const { coverImage, avatarImage, name } = updates;

    if (!coverImage && !avatarImage && name === undefined) throw new Error("400:provide_cover_image_avatar_image_or_name");

    // 1. Fetch existing file and JSON content
    const existingFile = await IPFS.getFileById(id);

    if (!existingFile || !existingFile.publicData) throw new Error("404:collection_not_found");

    const { owner: actualOwner } = existingFile.publicData;
    if (!actualOwner) throw new Error("400:collection_owner_undefined");
    if (!authdUser) throw new Error("400:missing_auth_payload_body_empty");

    // 2. Fetch existing JSON content
    const existingJson = await _fetchIpfsJson(existingFile.url);
    if (!existingJson) throw new Error("404:collection_content_not_found");

    // 3. Verify auth
    await _validateAuth(authdUser);

    if (actualOwner.toLowerCase() !== authdUser.owner.toLowerCase()) throw new Error("403:unauthorized");

    // 4. Merge updates (only non-empty values)
    const collectionData = {
        ...existingJson,
        ...(coverImage && { coverImage }),
        ...(avatarImage && { avatarImage }),
        ...(name !== undefined && { name: name || existingJson.name }),
    };

    // 5. Delete old pin
    await IPFS.deleteFiles([id]);

    // 6. Re-pin with updated content
    const fileName = `collection_${collectionData.name?.replace(/\s+/g, "_") || "collection"}_${Date.now()}.json`;
    // Pinata allows max 9 keyvalues per pin. Only filterable fields; display content in JSON body.
    const ipfsMetadata = {
        category: "blockdag_nft_collection",
        owner: collectionData.owner,
        contractAddress: collectionData.contractAddress || "",
        name: collectionData.name,
        symbol: collectionData.symbol,
        walletType: collectionData.walletType || "external",
        collectionCategory: collectionData.category || "Art",
    };
    const base64Data = Buffer.from(JSON.stringify(collectionData)).toString("base64");
    const base64Json = `data:application/json;base64,${base64Data}`;
    const ipfsResult = await IPFS.pinFile(base64Json, fileName, "application/json", ipfsMetadata);

    return {
        success: true,
        ipfs: ipfsResult,
        collection: collectionData,
    };
};

/**
 * Store NFT Metadata to IPFS
 * @param {Object} data
 * @param {Object} authdUser
 */
const storeNFT = async (data, authdUser) => {
    const { name, description, image, attributes, collectionAddress, walletType, proof, signature, message, owner, faceBase64, password, category } =
        data;

    // 1. Validate Auth
    await _validateAuth({ walletType, proof, signature, message, owner, faceBase64, password });
    const normalizedOwner = _normalizeAddress(owner, "400:invalid_owner_address");
    const { normalizedCollectionAddress } = await _resolveCollectionWriteAccess(collectionAddress, normalizedOwner);
    _ensureMessageIncludesCollection(message, normalizedCollectionAddress);

    // 1b. Verify the image is actually accessible before baking its URL into the NFT JSON.
    // This prevents "ghost" NFTs with broken images from ever being minted.
    // We normalise the URL first so the check always uses the current production gateway.
    if (!image || typeof image !== "string" || !image.trim()) {
        throw new Error("400:image_url_required");
    }

    const normalizedImageUrl = IPFS.rewriteGatewayUrl(image.trim());

    try {
        const imageCheck = await fetch(normalizedImageUrl, {
            method: "HEAD",
            signal: AbortSignal.timeout(10000),
        });

        if (!imageCheck.ok) {
            throw new Error(`image_not_accessible:http_${imageCheck.status}`);
        }

        const contentType = imageCheck.headers.get("content-type") || "";
        if (contentType.includes("text/html")) {
            // Gateway returned an HTML error page (e.g. ERR_ID:00023)
            throw new Error("image_not_accessible:gateway_returned_html");
        }
    } catch (e) {
        // Re-throw our own errors unchanged; wrap fetch/timeout errors with user-friendly message
        if (e.message.startsWith("image_not_accessible") || e.message.startsWith("400:")) throw e;
        throw new Error(`400:image_not_accessible: The image at ${normalizedImageUrl} could not be reached (${e.message}). Make sure the image is pinned and accessible on ipfs.zelf.world before creating NFT metadata.`);
    }

    // 2. Prepare Metadata — ERC-721 / OpenSea standard

    const safeDescription = String(description ?? "").slice(0, 5000);
    const nftData = {
        name,
        description: safeDescription,
        image: normalizedImageUrl,   // always use production gateway URL
        external_url: "https://zelf.world",
        category: category || "Art",
        attributes: attributes || [],
        properties: {
            files: [
                {
                    type: "image/png",
                    uri: normalizedImageUrl,  // always use production gateway URL
                },
            ],
            category: "image",
        },
    };

    // 3. Pin to IPFS (ERC-721 standard JSON metadata)
    const fileName = `nft_${name.replace(/\s+/g, "_")}_${Date.now()}.json`;

    // Pinata keyvalues: filterable fields only. Description and image live in the pinned ERC-721 JSON (standard NFT).
    const ipfsMetadata = {
        category: "blockdag_nft_item",
        owner: normalizedOwner,
        collection: normalizedCollectionAddress || "",
        name: name,
        nftCategory: category || "Art",
    };

    const base64Data = Buffer.from(JSON.stringify(nftData)).toString("base64");
    const base64Json = `data:application/json;base64,${base64Data}`;
    const ipfsResult = await IPFS.pinFile(base64Json, fileName, "application/json", ipfsMetadata);

    // Note: on-chain minting is handled by the frontend (user signs their own tx).
    // After minting, the frontend calls PATCH /api/blockdag/nft/item/:ipfsId/token
    // to persist the tokenId back into the IPFS metadata.

    return {
        success: true,
        ipfs: ipfsResult,
        nft: nftData,
    };
};

/**
 * List collections — enriched with real IPFS JSON content.
 * Optionally filtered by owner address (case-insensitive).
 * @param {Object} options
 * @param {string} [options.owner] - Filter by owner address
 * @param {number} [options.limit=25] - Max results (capped at 100)
 */
const listCollections = async ({ owner, contractAddress, limit } = {}) => {
    const maxResults = Math.min(Number(limit) || 25, 100);
    let results;

    if (contractAddress) {
        // Most specific filter: look up a single collection by its on-chain contract address
        const addrChecksum = ethers.getAddress(contractAddress);
        const addrLower = contractAddress.toLowerCase();
        const queries = [IPFS.filter("contractAddress", addrChecksum, { limit: 2 })];
        if (addrLower !== addrChecksum) queries.push(IPFS.filter("contractAddress", addrLower, { limit: 2 }));
        const all = (await Promise.all(queries)).flat();
        const seen = new Set();
        results = all.filter((item) => {
            if (seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
        });
        results = results.filter((item) => item.publicData?.category === "blockdag_nft_collection");
    } else if (owner) {
        const ownerChecksum = ethers.getAddress(owner);
        const ownerLower = owner.toLowerCase();
        const queries = [IPFS.filter("owner", ownerChecksum, { limit: maxResults })];
        if (ownerLower !== ownerChecksum) queries.push(IPFS.filter("owner", ownerLower, { limit: maxResults }));
        const all = (await Promise.all(queries)).flat();
        const seen = new Set();
        results = all.filter((item) => {
            if (seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
        });
        results = results.filter((item) => item.publicData?.category === "blockdag_nft_collection");
        results.forEach((item) => {
            if (item.publicData?.owner && item.publicData.owner !== ownerChecksum) {
                IPFS.updateFileKeyvalues(item.id, { owner: ownerChecksum }).catch(() => { });
            }
        });
    } else {
        results = await IPFS.filter("category", "blockdag_nft_collection", { limit: maxResults });
    }

    if (results.length > maxResults) results = results.slice(0, maxResults);

    const enriched = await Promise.all(
        results.map(async (item) => {
            const pd = item.publicData || {};

            // Skip gateway fetch when keyvalues already contain display fields
            if (pd.coverImage) {
                return {
                    name: pd.name || item.name || "",
                    symbol: pd.symbol || "",
                    description: pd.description || "",
                    coverImage: pd.coverImage || "",
                    avatarImage: pd.avatarImage || "",
                    category: pd.collectionCategory || pd.category || "Art",
                    owner: pd.owner || "",
                    contractAddress: pd.contractAddress || "",
                    walletType: pd.walletType || "",
                    verified: false,
                    ipfsUrl: item.url,
                    ipfsId: item.id,
                    cid: item.cid,
                };
            }

            const metadata = await _fetchIpfsJson(item.url);
            return {
                ...metadata,
                ...pd,
                category: metadata?.category || pd.collectionCategory || "Art",
                ipfsUrl: item.url,
                ipfsId: item.id,
                cid: item.cid,
            };
        })
    );

    return enriched;
};

// ── CID-level cache for IPFS gateway JSON fetches (node-cache) ───────────────
// Top CIDs were being re-fetched ~5 000 times each; this eliminates repeat calls.
const NodeCache = require("node-cache");
const _ipfsJsonCache = new NodeCache({
    stdTTL: 600, // 10 minutes
    checkperiod: 120,
    useClones: false,
});

// ── Collection search index cache ────────────────────────────────────────────
// Instead of treating Pinata pages as immutable (they are NOT — newest-first
// pagination shifts older items across page boundaries as new collections arrive),
// we maintain a flat in-memory index keyed by stable ipfsId/contractAddress.
//
// Refresh policy:
//  HEAD refresh (newest 2 pages):  every 1h  — catches new collections
//  DEEP refresh (all pages):       every 24h — catches anything missed
//
// This means at most 2 Pinata queries per hour and 1 full scan per day,
// regardless of how many times searchCollectionsByName() is called.
// ─────────────────────────────────────────────────────────────────────────────

const _COL_INDEX_HEAD_TTL = 60 * 60 * 1000;       // 1 hour in ms
const _COL_INDEX_DEEP_TTL = 24 * 60 * 60 * 1000;  // 24 hours in ms
const _COL_HEAD_PAGES = 2;                          // pages to refresh hourly

const _collectionIndex = {
    /** Map<ipfsId, rawPinataItem> — stable key, no duplicates across page shifts */
    byId: new Map(),
    lastHeadRefreshAt: 0,
    lastDeepRefreshAt: 0,
    /** True while a deep refresh is in-flight (prevents concurrent deep scans) */
    deepRefreshPromise: null,
};

/**
 * Fetch N pages from Pinata and merge results into the in-memory index.
 * Uses ipfsId as the primary key so items re-indexed across page boundaries
 * do not create duplicates or disappear.
 *
 * @param {number} maxPages - How many pages to fetch (0 = all pages)
 */
const _refreshCollectionIndex = async (maxPages = 0) => {
    const PAGE_SIZE = 100;
    let pageCount = 0;
    let pageToken = null;

    while (true) {
        const { files, nextPageToken } = await IPFS.filterPaged("category", "blockdag_nft_collection", {
            pageSize: PAGE_SIZE,
            pageToken: pageToken || undefined,
        });

        for (const item of files) {
            const key = item.id || item.cid || (item.publicData?.contractAddress || "");
            if (key) _collectionIndex.byId.set(key, item);
        }

        pageCount++;
        pageToken = nextPageToken;

        if (!nextPageToken || files.length === 0) break;
        if (maxPages > 0 && pageCount >= maxPages) break;
    }
};

/**
 * Ensure the index is up to date, using the tiered refresh policy.
 * - Head refresh (newest 2 pages): at most once per hour
 * - Deep refresh (all pages):      at most once per 24 hours
 */
const _ensureCollectionIndexFresh = async () => {
    const now = Date.now();
    const headExpired = now - _collectionIndex.lastHeadRefreshAt > _COL_INDEX_HEAD_TTL;
    const deepExpired = now - _collectionIndex.lastDeepRefreshAt > _COL_INDEX_DEEP_TTL;

    if (deepExpired) {
        // Only one deep refresh at a time to avoid thundering herd
        if (_collectionIndex.deepRefreshPromise) {
            await _collectionIndex.deepRefreshPromise;
        } else {
            _collectionIndex.deepRefreshPromise = _refreshCollectionIndex(0)
                .then(() => {
                    _collectionIndex.lastHeadRefreshAt = Date.now();
                    _collectionIndex.lastDeepRefreshAt = Date.now();
                })
                .finally(() => {
                    _collectionIndex.deepRefreshPromise = null;
                });
            await _collectionIndex.deepRefreshPromise;
        }
    } else if (headExpired) {
        await _refreshCollectionIndex(_COL_HEAD_PAGES);
        _collectionIndex.lastHeadRefreshAt = Date.now();
    }
    // Otherwise index is fresh — zero Pinata calls
};

/**
 * Enrich a list of raw Pinata file objects into the same shape as listCollections().
 * Skips the IPFS gateway JSON fetch when keyvalues already contain coverImage.
 */
const _enrichCollections = async (rawItems) => {
    return Promise.all(
        rawItems.map(async (item) => {
            const pd = item.publicData || {};
            if (pd.coverImage) {
                return {
                    name: pd.name || item.name || "",
                    symbol: pd.symbol || "",
                    description: pd.description || "",
                    coverImage: pd.coverImage || "",
                    avatarImage: pd.avatarImage || "",
                    category: pd.collectionCategory || pd.category || "Art",
                    owner: pd.owner || "",
                    contractAddress: pd.contractAddress || "",
                    walletType: pd.walletType || "",
                    verified: false,
                    ipfsUrl: item.url,
                    ipfsId: item.id,
                    cid: item.cid,
                };
            }
            const metadata = await _fetchIpfsJson(item.url);
            return {
                ...metadata,
                ...pd,
                category: metadata?.category || pd.collectionCategory || "Art",
                ipfsUrl: item.url,
                ipfsId: item.id,
                cid: item.cid,
            };
        })
    );
};

/**
 * Search collections by name (or symbol) substring.
 * Uses the stable collection index cache — zero Pinata calls when the index is warm,
 * at most 2 pages fetched per hour for the head refresh, 1 full scan per 24h for deep.
 *
 * @param {string} query - Case-insensitive substring to match against collection name/symbol
 * @returns {Promise<Array>} Enriched collection objects
 */
const searchCollectionsByName = async (query) => {
    const lowerQuery = query.toLowerCase().trim();

    await _ensureCollectionIndexFresh();

    const allRaw = Array.from(_collectionIndex.byId.values());
    const matched = allRaw.filter((item) => {
        const pd = item.publicData || {};
        const name = (pd.name || item.name || "").toLowerCase();
        const symbol = (pd.symbol || "").toLowerCase();
        return name.includes(lowerQuery) || symbol.includes(lowerQuery);
    });

    return _enrichCollections(matched);
};

const _extractCid = (url) => {
    const m = url.match(/\/ipfs\/([^/?#]+)/);
    return m ? m[1] : null;
};

const _isDev = config.env === "development";

/**
 * Fetch the actual JSON content stored at an IPFS URL.
 * Results are cached by CID (via node-cache, 10 min TTL) to avoid repeated gateway calls.
 * Returns null if the fetch fails or the content is not valid JSON.
 */
const _fetchIpfsJson = async (url) => {
    if (!url) return null;

    const cid = _extractCid(url);
    const cacheKey = cid || url;

    const cached = _ipfsJsonCache.get(cacheKey);
    if (cached !== undefined) {
        if (_isDev) {
            const { hits, misses } = _ipfsJsonCache.getStats();
            const note = cached === null ? "cached failure (5min)" : "from cache";
            console.log(`[IPFS-cache] HIT  ${cacheKey.slice(0, 20)}…  ← ${note} | session: ${hits} hits, ${misses} gateway fetches`);
        }
        return cached;
    }

    if (_isDev) {
        const { misses } = _ipfsJsonCache.getStats();
        console.log(`[IPFS-cache] MISS ${cacheKey.slice(0, 20)}…  → fetching from gateway (fetch #${misses + 1} this session)`);
    }

    try {
        const res = await fetch(url);
        if (!res.ok) {
            _ipfsJsonCache.set(cacheKey, null, 300); // cache failures for 5 min
            return null;
        }
        const json = await res.json();
        _ipfsJsonCache.set(cacheKey, json);
        return json;
    } catch (e) {
        _ipfsJsonCache.set(cacheKey, null, 300); // cache failures for 5 min
        return null;
    }
};

const _parseAttributesJson = (raw) => {
    if (!raw || typeof raw !== "string") return null;
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
};

const _mergeItemAttributes = (metadata, publicData) => {
    const pd = publicData || {};
    const fromKv = _parseAttributesJson(pd.attributesJson);
    if (fromKv) return fromKv;
    if (Array.isArray(metadata?.attributes)) return metadata.attributes;
    return [];
};

/**
 * Enrich raw IPFS file results with fetched JSON metadata.
 * Description, image, and attributes prefer the pinned ERC-721 JSON; legacy Pinata keyvalues are fallbacks only.
 */
const _enrichItems = async (rawResults) => {
    return Promise.all(
        rawResults.map(async (item) => {
            const metadata = await _fetchIpfsJson(item.url);
            const pd = item.publicData || {};
            const attributes = _mergeItemAttributes(metadata, pd);
            const rawImage =
                metadata && metadata.image != null && String(metadata.image).trim() !== ""
                    ? String(metadata.image).trim()
                    : "";
            // Normalise any stored gateway URL to the current production gateway.
            // Prevents images baked with a dev/old gateway from breaking at read time.
            const jsonImage = IPFS.rewriteGatewayUrl(rawImage);
            return {
                ...pd,
                ...metadata,
                attributes,
                name: pd.name || metadata?.name || item.name || "",
                description:
                    metadata && metadata.description !== undefined && metadata.description !== null
                        ? metadata.description
                        : (pd.description ?? ""),
                image: jsonImage || IPFS.rewriteGatewayUrl(pd.image) || "",
                category: metadata?.category || pd.nftCategory || pd.collectionCategory || pd.category || "Art",
                owner: pd.owner || "",
                collection: pd.collection || "",
                contractAddress: pd.contractAddress || pd.collection || "",
                tokenId: pd.tokenId || "",
                mintTxHash: pd.mintTxHash || "",
                ipfsUrl: IPFS.rewriteGatewayUrl(item.url),
                ipfsId: item.id,
                cid: item.cid,
            };
        })
    );
};

/**
 * Check if a string looks like an IPFS CID (v0 Qm... or v1 bafy.../bafk.../bafz...).
 */
const _isIpfsCid = (s) => {
    if (!s || typeof s !== "string") return false;
    const t = s.trim();
    return t.startsWith("Qm") || t.startsWith("baf") || t.startsWith("ba") || /^[a-zA-Z0-9]{46,}$/.test(t);
};

/**
 * Get a single NFT item by Pinata file ID or IPFS CID.
 * Prefers CID lookup when the id looks like a CID (standard, content-addressed).
 */
const getItem = async (id) => {
    if (!id) throw new Error("400:missing_id");

    let item;

    if (_isIpfsCid(id)) {
        // Lookup by IPFS CID (standard, content-addressed)
        const results = await IPFS.filter("cid", id.trim());
        item = results[0];
    } else {
        // Lookup by Pinata file ID (UUID)
        try {
            item = await IPFS.getFileById(id);
        } catch {
            throw new Error("404:nft_not_found");
        }
        if (item?.publicData?.category !== "blockdag_nft_item") {
            throw new Error("404:nft_not_found");
        }
    }

    if (!item) throw new Error("404:nft_not_found");

    const metadata = await _fetchIpfsJson(item.url);
    const pd = item.publicData || {};
    const attributes = _mergeItemAttributes(metadata, pd);

    const rawImage =
        metadata && metadata.image != null && String(metadata.image).trim() !== ""
            ? String(metadata.image).trim()
            : "";
    // Normalise any stored gateway URL to the current production gateway.
    const jsonImage = IPFS.rewriteGatewayUrl(rawImage);
    const result = {
        ...metadata,
        ...pd,
        attributes,
        name: pd.name || metadata?.name || "",
        // Canonical description is in token JSON; ignore legacy Pinata description keyvalue when JSON has a value
        description:
            metadata && (metadata.description !== undefined && metadata.description !== null)
                ? metadata.description
                : (pd.description ?? ""),
        // Always rewrite image and ipfsUrl to the current gateway
        image: jsonImage || IPFS.rewriteGatewayUrl(pd.image) || "",
        category: metadata?.category || pd.nftCategory || "Art",
        ipfsUrl: IPFS.rewriteGatewayUrl(item.url),
        ipfsId: item.id,
        cid: item.cid,
    };

    ownerDebugLog("getItem", {
        requestId: id,
        cid: result.cid,
        ipfsId: result.ipfsId,
        owner: result.owner || "",
        tokenId: result.tokenId || "",
        collection: result.collection || result.contractAddress || "",
    });

    return result;
};

/**
 * Get items for a single collection.
 * Uses single-key filter (Pinata only supports one key) — filter by "collection" to avoid category's 50-item limit.
 * @param {string} collectionAddress - Contract address of the collection (0x...)
 * @param {Object} options - { owner, limit } for optional filters
 */
const getItemsByCollection = async (collectionAddress, options = {}) => {
    if (!collectionAddress) return [];

    const rawLimit = options.limit != null ? Number(options.limit) : 50;
    const validLimit = [25, 50, 100, 250, 500].includes(rawLimit) ? rawLimit : 50;

    // Pinata supports only ONE key filter — use "collection" (items with this key are NFT items)
    const colNorm = collectionAddress.toLowerCase();
    let results = await IPFS.filter("collection", colNorm, { limit: validLimit });
    if (results.length === 0 && collectionAddress !== colNorm) {
        results = await IPFS.filter("collection", collectionAddress, { limit: validLimit });
    }

    if (options.owner) {
        results = results.filter((item) => item.publicData?.owner?.toLowerCase() === options.owner.toLowerCase());
    }

    return _enrichItems(results);
};

/**
 * List items (optionally filtered by owner or collection).
 * Default limit: 50 (max 200). Reduces Pinata + gateway request volume.
 */
const listItems = async (filterParams) => {
    const { owner, collection, limit } = filterParams;
    // When filtering by owner allow up to 1000 (full history); general browse stays capped at 200
    const maxResults = owner
        ? Math.min(Number(limit) || 1000, 1000)
        : Math.min(Number(limit) || 50, 200);

    if (collection) {
        return getItemsByCollection(collection, { owner, limit: limit || 50 });
    }

    if (owner) {
        const ownerChecksum = ethers.getAddress(owner);
        const ownerLower = owner.toLowerCase();
        const queries = [IPFS.filter("owner", ownerChecksum, { limit: maxResults })];
        if (ownerLower !== ownerChecksum) queries.push(IPFS.filter("owner", ownerLower, { limit: maxResults }));
        const all = (await Promise.all(queries)).flat();
        const seen = new Set();
        let results = all.filter((item) => {
            if (seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
        });
        results.forEach((item) => {
            if (item.publicData?.owner && item.publicData.owner !== ownerChecksum) {
                IPFS.updateFileKeyvalues(item.id, { owner: ownerChecksum }).catch(() => { });
            }
        });
        if (results.length > maxResults) results = results.slice(0, maxResults);
        ownerDebugLog("listItemsByOwner", {
            owner,
            ownerChecksum,
            count: results.length,
            items: results.slice(0, 20).map((item) => ({
                id: item.id,
                cid: item.cid,
                owner: item.publicData?.owner || "",
                tokenId: item.publicData?.tokenId || "",
                collection: item.publicData?.collection || "",
            })),
        });
        return _enrichItems(results);
    }

    let results = await IPFS.filter("category", "blockdag_nft_item", { limit: maxResults });

    return _enrichItems(results);
};

/**
 * Upload an image/file to IPFS
 * @param {Object} file - The file object from ctx.request.files.file
 */
const upload = async (file) => {
    if (!file) throw new Error("400:no_file_provided");

    // Read the file and convert to base64
    const fileContent = fs.readFileSync(file.filepath);
    const base64Data = fileContent.toString("base64");
    const mimeType = file.mimetype || "application/octet-stream";

    // Construct data URI required by IPFS.pinFile
    const dataUri = `data:${mimeType};base64,${base64Data}`;
    const fileName = `blockdag_nft_media_${Date.now()}_${file.originalFilename || "file"}`.replace(/[^a-zA-Z0-9_.-]/g, "_");

    // Searchable metadata for the media
    const ipfsMetadata = {
        category: "blockdag_nft_media",
        originalName: file.originalFilename || "unknown",
    };

    const ipfsResult = await IPFS.pinFile(dataUri, fileName, mimeType, ipfsMetadata);

    if (!ipfsResult) {
        throw new Error("500:ipfs_upload_failed");
    }

    return {
        url: ipfsResult.url,
        ipfsHash: ipfsResult.cid,
    };
};

/**
 * Mint an NFT on-chain using the collection owner's (deployer) wallet.
 * Called automatically by storeNFT after IPFS metadata is uploaded.
 *
 * @param {string} collectionAddress  ERC-721 contract address
 * @param {string} recipientAddress   Wallet that will receive the token
 * @param {string} tokenURI           IPFS metadata URL
 * @returns {{ tokenId: number, txHash: string }}
 */
const mintOnChain = async (collectionAddress, recipientAddress, tokenURI, authPayload = {}) => {
    await _validateAuth(authPayload);
    const normalizedOwner = _normalizeAddress(authPayload.owner, "400:invalid_owner_address");
    const { normalizedCollectionAddress, isDefaultCollection } = await _resolveCollectionWriteAccess(collectionAddress, normalizedOwner);
    _ensureMessageIncludesCollection(authPayload.message, normalizedCollectionAddress);
    if (!isDefaultCollection) {
        throw new Error("403:backend_mint_shared_collection_only");
    }

    const provider = _getBlockDagProvider();
    const normalizedRecipient = _normalizeAddress(recipientAddress, "400:invalid_recipient_address");

    let wallet;
    if (config.blockdag?.deployerPrivateKey) {
        wallet = new ethers.Wallet(config.blockdag.deployerPrivateKey, provider);
    } else if (process.env.BLOCKDAG_DEPLOYER_PRIVATE_KEY) {
        wallet = new ethers.Wallet(process.env.BLOCKDAG_DEPLOYER_PRIVATE_KEY, provider);
    } else if (process.env.WALRUS_PRIVATE_KEY) {
        const mnemonic = process.env.WALRUS_PRIVATE_KEY.trim();
        const base = ethers.Wallet.fromPhrase(mnemonic);
        wallet = base.connect(provider);
    } else {
        throw new Error("No deployer private key configured for on-chain minting");
    }

    const collection = new ethers.Contract(normalizedCollectionAddress, ERC721_ABI, wallet);
    const tx = await collection.mint(normalizedRecipient, tokenURI);
    const receipt = await tx.wait();

    // tokenId is the return value of mint() — read from Transfer event
    let tokenId = null;
    for (const log of receipt.logs) {
        try {
            const parsed = collection.interface.parseLog({
                topics: [...log.topics],
                data: log.data,
            });
            if (parsed && parsed.name === "Transfer") {
                tokenId = (parsed.args[2] || parsed.args.tokenId).toString();
                break;
            }
        } catch (e) { }
    }

    return { tokenId, txHash: receipt.hash };
};

/**
 * Update an NFT item's on-chain tokenId.
 */
const updateItemTokenId = async (ipfsFileId, tokenId, txHash) => {
    const keyvalues = {
        tokenId: String(tokenId),
        mintTxHash: txHash || "",
    };
    const newPin = await IPFS.updateFileKeyvalues(ipfsFileId, keyvalues);

    return {
        success: true,
        method: newPin.method || "update",
        newIpfsId: newPin.id || ipfsFileId,
        newCid: newPin.cid,
        newUrl: newPin.url,
        tokenId,
        txHash,
    };
};

/**
 * Replace an NFT pin with updated metadata (tokenId, txHash, owner).
 * Verifies owner on-chain via ownerOf(tokenId) instead of trusting frontend.
 * Falls back to provided owner if chain call fails.
 *
 * @param {string} ipfsFileId - Current Pinata file ID
 * @param {string|number} tokenId - On-chain token ID
 * @param {string} txHash - Mint/sale tx hash
 * @param {string} [owner] - Hint; overridden by on-chain ownerOf when available.
 */
const replaceNftItemWithNewOwner = async (ipfsFileId, tokenId, txHash, owner, authPayload = {}) => {
    await _validateAuth(authPayload);
    const normalizedRequester = _normalizeAddress(authPayload.owner, "400:invalid_owner_address");
    const item = await getItem(ipfsFileId);
    const publicData = item.publicData || {};
    const collectionAddr = item.collection || publicData.collection || "";
    const resolvedPinataId = item.ipfsId || item.id || ipfsFileId;
    const normalizedCollectionAddr =
        collectionAddr && collectionAddr !== "none" ? _normalizeAddress(collectionAddr, "400:invalid_collection_address") : collectionAddr;
    const previousMetaOwner = item.owner ?? publicData.owner ?? "";

    if (normalizedCollectionAddr && normalizedCollectionAddr !== "none") {
        await _authorizeReplaceNftItem(normalizedCollectionAddr, normalizedRequester, tokenId, previousMetaOwner);
        _ensureMessageIncludesCollection(authPayload.message, normalizedCollectionAddr);
    }

    let resolvedOwner = owner ? _normalizeAddress(owner, "400:invalid_owner_address") : item.owner ?? publicData.owner ?? "";
    const previousOwner = item.owner ?? publicData.owner ?? "";
    if (normalizedCollectionAddr && normalizedCollectionAddr !== "none" && tokenId) {
        try {
            const contract = new ethers.Contract(normalizedCollectionAddr, ERC721_ABI, _getBlockDagProvider());
            resolvedOwner = await contract.ownerOf(BigInt(tokenId));
        } catch (error) {
            console.error("[replaceNftItemWithNewOwner] ownerOf verify failed", normalizedCollectionAddr, tokenId, error?.message || error);
            throw new Error("503:chain_owner_verify_failed");
        }
    }

    const keyvalues = {
        category: "blockdag_nft_item",
        collection: normalizedCollectionAddr || item.collection || publicData.collection || "",
        name: item.name || publicData.name || "NFT",
        owner: resolvedOwner ? _normalizeAddress(resolvedOwner, "400:invalid_owner_address") : "",
        tokenId: String(tokenId),
        mintTxHash: txHash || publicData.mintTxHash || "",
    };

    const newPin = await IPFS.updateFileKeyvalues(resolvedPinataId, keyvalues);
    ownerDebugLog("replaceNftItemWithNewOwner", {
        ipfsFileId,
        resolvedPinataId,
        tokenId: String(tokenId),
        txHash: txHash || "",
        previousOwner,
        requestedOwner: owner || "",
        resolvedOwner,
        collectionAddr,
        newIpfsId: newPin.id ?? ipfsFileId,
        newCid: newPin.cid,
    });

    return {
        success: true,
        newIpfsId: newPin.id ?? ipfsFileId,
        newCid: newPin.cid,
        newUrl: newPin.url,
        tokenId,
        txHash,
    };
};

/**
 * Generic Pinata keyvalue update for any pinned file.
 * Delegates to IPFS.updateFileKeyvalues.
 */
const updatePinKeyvalues = async (ipfsFileId, keyvalues) => {
    return IPFS.updateFileKeyvalues(ipfsFileId, keyvalues);
};

const _sanitizeNftAttributes = (attrs) => {
    if (!Array.isArray(attrs)) return [];
    return attrs
        .filter((a) => a && typeof a === "object")
        .map((a) => ({
            trait_type: String(a.trait_type ?? a.traitType ?? "").trim().slice(0, 64),
            value: String(a.value ?? "").trim().slice(0, 256),
        }))
        .filter((a) => a.trait_type && a.value);
};

/**
 * Update display metadata (name, description, attributes) for an existing NFT.
 * Writes to the pinned ERC-721 JSON only (standard NFT). Does not store description or image in Pinata keyvalues.
 * Re-pins JSON (delete + pin) so the file content updates; returns new Pinata file id / CID — clients should navigate to new id.
 *
 * Authorization (strict owner-only):
 * - Minted (tokenId + collection): JsonRpcProvider ownerOf(tokenId) MUST equal EIP-191 signer address.
 * - Draft (no token on-chain yet): Pinata keyvalue `owner` MUST equal signer address.
 * Signed message binds ipfsFileId + collection (see _ensureMessageIncludesCollection).
 */
const updateNftItemDisplayMetadata = async (ipfsFileId, { name, description, attributes }, authPayload) => {
    if (!ipfsFileId) throw new Error("400:missing_id");
    if (!authPayload) throw new Error("400:missing_auth_payload_body_empty");

    await _validateAuth(authPayload);
    const normalizedRequester = _normalizeAddress(authPayload.owner, "400:invalid_owner_address");

    const existingFile = await IPFS.getFileById(ipfsFileId);
    if (!existingFile?.publicData || existingFile.publicData.category !== "blockdag_nft_item") {
        throw new Error("404:item_not_found");
    }

    const pd = existingFile.publicData;
    const collectionRaw = (pd.collection || "").trim();
    if (!collectionRaw || collectionRaw.toLowerCase() === "none") {
        throw new Error("400:missing_collection_on_item");
    }
    const normalizedCollectionAddr = _normalizeAddress(collectionRaw, "400:invalid_collection_address");

    const msg = authPayload.message;
    if (typeof msg !== "string") throw new Error("400:invalid_message");
    const itemMatch = msg.match(/^I authorize updating NFT metadata for item (.+?) in collection .+?\. Timestamp: \d+$/);
    if (!itemMatch || itemMatch[1] !== ipfsFileId) {
        throw new Error("400:message_item_mismatch");
    }
    _ensureMessageIncludesCollection(msg, normalizedCollectionAddr);

    const actualOwner = pd.owner;
    if (!actualOwner) throw new Error("400:item_owner_undefined");

    const rawTokenId = pd.tokenId != null && pd.tokenId !== "" ? String(pd.tokenId).trim() : "";
    const hasMintedContext = rawTokenId !== "" && collectionRaw.toLowerCase() !== "none";

    if (hasMintedContext) {
        try {
            const contract = new ethers.Contract(normalizedCollectionAddr, ERC721_ABI, _getBlockDagProvider());
            const chainOwner = await contract.ownerOf(BigInt(rawTokenId));
            const co = _normalizeAddress(chainOwner, "400:invalid_chain_owner");
            if (co.toLowerCase() !== normalizedRequester.toLowerCase()) {
                throw new Error("403:unauthorized_not_chain_owner");
            }
        } catch (e) {
            if (e && typeof e.message === "string" && (e.message.startsWith("403:") || e.message.startsWith("400:"))) {
                throw e;
            }
            console.error("[updateNftItemDisplayMetadata] ownerOf verify failed", e?.message || e);
            throw new Error("503:chain_owner_verify_failed");
        }
    } else if (actualOwner.toLowerCase() !== normalizedRequester.toLowerCase()) {
        throw new Error("403:unauthorized");
    }

    const metadata = await _fetchIpfsJson(existingFile.url);
    const canonicalImage =
        metadata && metadata.image != null && String(metadata.image).trim() !== ""
            ? String(metadata.image).trim()
            : String(pd.image || "").trim();
    if (!canonicalImage) throw new Error("400:missing_canonical_image");

    let nextName =
        name !== undefined && name !== null ? String(name).trim().slice(0, 256) : String(pd.name || metadata?.name || "NFT").slice(0, 256);
    if (!nextName) nextName = String(pd.name || metadata?.name || "NFT").slice(0, 256) || "NFT";
    let nextDescription =
        description !== undefined && description !== null
            ? String(description)
            : String(metadata?.description ?? pd.description ?? "");
    nextDescription = nextDescription.slice(0, 5000);

    let attrsSource = _mergeItemAttributes(metadata, pd);
    if (attributes !== undefined && attributes !== null) {
        attrsSource = attributes;
    }
    const sanitized = _sanitizeNftAttributes(attrsSource);
    const attrsJson = JSON.stringify(sanitized);
    if (attrsJson.length > 12000) throw new Error("400:attributes_too_large");

    const nftData = {
        ...(metadata && typeof metadata === "object" ? metadata : {}),
        name: nextName,
        description: nextDescription,
        image: canonicalImage,
        attributes: sanitized,
        external_url: metadata?.external_url || "https://zelf.world",
        category: metadata?.category || pd.nftCategory || "Art",
        properties:
            metadata?.properties && typeof metadata.properties === "object"
                ? metadata.properties
                : {
                    files: [{ type: "image/png", uri: canonicalImage }],
                    category: "image",
                },
    };

    const oldCid = _extractCid(existingFile.url);
    if (oldCid) _ipfsJsonCache.del(oldCid);

    await IPFS.deleteFiles([ipfsFileId]);

    const fileName = `nft_${nextName.replace(/\s+/g, "_")}_${Date.now()}.json`;
    const ipfsMetadata = {
        category: "blockdag_nft_item",
        owner: pd.owner,
        collection: normalizedCollectionAddr || "",
        name: nextName.slice(0, 250),
        nftCategory: String(nftData.category || "Art").slice(0, 64),
    };

    if (rawTokenId) {
        ipfsMetadata.tokenId = String(rawTokenId);
    }
    if (pd.mintTxHash != null && String(pd.mintTxHash).trim() !== "") {
        ipfsMetadata.mintTxHash = String(pd.mintTxHash).slice(0, 128);
    }

    const base64Data = Buffer.from(JSON.stringify(nftData)).toString("base64");
    const base64Json = `data:application/json;base64,${base64Data}`;
    const ipfsResult = await IPFS.pinFile(base64Json, fileName, "application/json", ipfsMetadata);

    if (!ipfsResult?.cid) throw new Error("500:metadata_repin_failed");

    const newCid = ipfsResult.cid;
    if (newCid) _ipfsJsonCache.del(newCid);

    const newIpfsId = ipfsResult.id || ipfsResult.Id;

    return {
        success: true,
        ipfsFileId: newIpfsId,
        newIpfsId,
        newCid,
        ipfs: ipfsResult,
        name: nextName,
        description: nextDescription,
        attributes: sanitized,
    };
};

/**
 * Repair a broken IPFS gateway URL for an NFT item.
 *
 * Pinata dedicated gateways (*.mypinata.cloud) only serve content that is pinned
 * to the same Pinata account. Content uploaded via the dev account cannot be served
 * by the production gateway — Pinata returns ERR_ID:00023.
 *
 * This function:
 * 1. Looks up the file by Pinata ID.
 * 2. Verifies it is a `blockdag_nft_item` with a valid collection.
 * 3. HEAD-checks the current ipfsUrl. If it works, returns { repaired: false }.
 * 4. If broken, fetches the raw JSON from the public IPFS gateway (ipfs.io),
 *    re-pins it to the production Pinata account with the same keyvalues,
 *    deletes the old pin, and returns the new URL.
 *
 * @param {string} ipfsFileId - Pinata file ID (UUID) of the NFT item
 * @returns {{ repaired: boolean, newIpfsId?: string, newUrl?: string, ipfsUrl?: string }}
 */
const repairGatewayUrl = async (ipfsFileId) => {
    if (!ipfsFileId) throw new Error("400:missing_ipfs_file_id");

    // 1. Fetch Pinata metadata
    let item;
    try {
        item = await IPFS.getFileById(ipfsFileId);
    } catch {
        throw new Error("404:nft_not_found");
    }

    if (!item) throw new Error("404:nft_not_found");

    const pd = item.publicData || {};

    // 2. Safety guard — only repair known NFT items belonging to a collection
    if (pd.category !== "blockdag_nft_item") throw new Error("400:not_an_nft_item");

    const collectionAddr = pd.collection || "";
    if (!collectionAddr || collectionAddr === "none" || !ethers.isAddress(collectionAddr)) {
        throw new Error("400:missing_collection_address");
    }

    const currentUrl = item.url;
    if (!currentUrl) throw new Error("400:missing_ipfs_url");

    // 3. HEAD-check the current URL — if it works, no repair needed
    try {
        const check = await fetch(currentUrl, { method: "HEAD", signal: AbortSignal.timeout(8000) });
        if (check.ok) return { repaired: false, ipfsUrl: currentUrl };
    } catch {
        // fall through to repair
    }

    // 4. Fetch raw JSON via a waterfall of public IPFS gateways.
    // gateway.pinata.cloud is tried first — it serves any CID pinned to ANY Pinata account
    // (unlike dedicated gateways which are account-scoped), so it has the highest chance of success.
    const cid = item.cid;
    if (!cid) throw new Error("400:missing_cid");

    const PUBLIC_GATEWAYS = [
        `https://gateway.pinata.cloud/ipfs/${cid}`,
        `https://cloudflare-ipfs.com/ipfs/${cid}`,
        `https://dweb.link/ipfs/${cid}`,
        `https://ipfs.io/ipfs/${cid}`,
    ];

    let rawJson = null;
    let lastError = "all_gateways_failed";

    for (const gatewayUrl of PUBLIC_GATEWAYS) {
        try {
            const res = await fetch(gatewayUrl, { signal: AbortSignal.timeout(15000) });
            if (!res.ok) {
                lastError = `gateway_http_${res.status}:${gatewayUrl}`;
                continue;
            }
            const contentType = res.headers.get("content-type") || "";
            if (contentType.includes("text/html")) {
                lastError = `gateway_returned_html:${gatewayUrl}`;
                continue;
            }
            rawJson = await res.json();
            break; // success
        } catch (e) {
            lastError = `${e.message}:${gatewayUrl}`;
            // try next gateway
        }
    }

    if (!rawJson) {
        throw new Error(`503:cannot_fetch_content_from_public_gateway: ${lastError}`);
    }

    // 5. Re-pin to production account with the same keyvalues (preserves all metadata)
    const fileName = item.name || `nft_repaired_${Date.now()}.json`;
    const base64Data = Buffer.from(JSON.stringify(rawJson)).toString("base64");
    const base64Json = `data:application/json;base64,${base64Data}`;

    const repinKeyvalues = {
        category: "blockdag_nft_item",
        owner: pd.owner || "",
        collection: pd.collection || "",
        name: pd.name || rawJson.name || "",
        nftCategory: pd.nftCategory || rawJson.category || "Art",
        ...(pd.tokenId != null && { tokenId: String(pd.tokenId) }),
        ...(pd.mintTxHash && { mintTxHash: pd.mintTxHash }),
    };

    const ipfsResult = await IPFS.pinFile(base64Json, fileName, "application/json", repinKeyvalues);

    if (!ipfsResult) throw new Error("500:repin_failed");

    // 6. Delete the old broken pin (best-effort — don't fail the repair if this errors)
    IPFS.deleteFiles([ipfsFileId]).catch((e) =>
        console.warn("[repairGatewayUrl] failed to delete old pin", ipfsFileId, e?.message),
    );

    // Bust the IPFS JSON cache for this CID so getItem returns fresh data
    _ipfsJsonCache.del(cid);

    return {
        repaired: true,
        newIpfsId: ipfsResult.id,
        newCid: ipfsResult.cid,
        newUrl: ipfsResult.url,
    };
};

module.exports = {
    upload,
    getItem,
    getDefaultCollection,
    deployDefaultCollection,
    storeCollection,
    updateCollection,
    deleteCollection,
    deleteItem,
    storeNFT,
    listCollections,
    listItems,
    getItemsByCollection,
    mintOnChain,
    updateItemTokenId,
    replaceNftItemWithNewOwner,
    updatePinKeyvalues,
    updateNftItemDisplayMetadata,
    searchCollectionsByName,
    repairGatewayUrl,
};
