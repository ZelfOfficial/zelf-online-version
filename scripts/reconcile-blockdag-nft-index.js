require("dotenv").config({ path: require("path").resolve(__dirname, "../.env"), override: true });

const { ethers } = require("ethers");
const IPFS = require("../Core/ipfs");
const config = require("../Core/config");

const OWNABLE_ABI = ["function owner() view returns (address)"];
const ERC721_ABI = ["function ownerOf(uint256 tokenId) view returns (address)"];

const provider = new ethers.JsonRpcProvider(config.blockdag?.rpcUrl || "https://rpc.east.bdag-us.org");
const defaultCollectionAddress =
    config.blockdag?.defaultCollectionAddress && ethers.isAddress(config.blockdag.defaultCollectionAddress)
        ? ethers.getAddress(config.blockdag.defaultCollectionAddress)
        : null;
const deleteUnauthorizedDrafts = process.env.BLOCKDAG_DELETE_UNAUTHORIZED_DRAFTS === "true";

const normalizeAddress = (value) => {
    if (!value || typeof value !== "string") return null;
    try {
        return ethers.getAddress(value.trim());
    } catch {
        return null;
    }
};

const listAllPins = async (category) => {
    const files = [];
    let pageToken = null;

    while (true) {
        const page = await IPFS.filterPaged("category", category, {
            pageSize: 100,
            pageToken: pageToken || undefined,
        });
        const pageFiles = page?.files || [];
        if (pageFiles.length === 0) break;
        files.push(...pageFiles);
        pageToken = page?.nextPageToken || null;
        if (!pageToken) break;
    }

    return files;
};

const getCollectionOwner = async (collectionAddress) => {
    const contract = new ethers.Contract(collectionAddress, OWNABLE_ABI, provider);
    const owner = await contract.owner();
    return owner ? ethers.getAddress(owner) : null;
};

const getTokenOwner = async (collectionAddress, tokenId) => {
    const contract = new ethers.Contract(collectionAddress, ERC721_ABI, provider);
    const owner = await contract.ownerOf(BigInt(tokenId));
    return owner ? ethers.getAddress(owner) : null;
};

async function main() {
    const stats = {
        collectionsScanned: 0,
        collectionsUpdated: 0,
        itemsScanned: 0,
        itemsUpdated: 0,
        unauthorizedDraftsFlagged: 0,
        unauthorizedDraftsDeleted: 0,
        ownerLookupFailures: 0,
    };

    const collectionOwners = new Map();
    const suspiciousDrafts = [];

    console.log("Scanning BlockDAG NFT collections...");
    const collectionPins = await listAllPins("blockdag_nft_collection");

    for (const pin of collectionPins) {
        stats.collectionsScanned += 1;
        const publicData = pin.publicData || {};
        const normalizedCollection = normalizeAddress(publicData.contractAddress);
        if (!normalizedCollection) continue;

        try {
            const onChainOwner = await getCollectionOwner(normalizedCollection);
            collectionOwners.set(normalizedCollection, onChainOwner);

            const updates = {};
            if (publicData.contractAddress !== normalizedCollection) {
                updates.contractAddress = normalizedCollection;
            }
            if (onChainOwner && publicData.owner !== onChainOwner) {
                updates.owner = onChainOwner;
            }

            if (Object.keys(updates).length > 0) {
                await IPFS.updateFileKeyvalues(pin.id, updates);
                stats.collectionsUpdated += 1;
            }
        } catch (error) {
            stats.ownerLookupFailures += 1;
            console.error(`Collection owner lookup failed for ${normalizedCollection}: ${error.message || error}`);
        }
    }

    console.log("Scanning BlockDAG NFT items...");
    const itemPins = await listAllPins("blockdag_nft_item");

    for (const pin of itemPins) {
        stats.itemsScanned += 1;
        const publicData = pin.publicData || {};
        const rawCollection = (publicData.collection || "").trim();
        const normalizedCollection = rawCollection && rawCollection.toLowerCase() !== "none" ? normalizeAddress(rawCollection) : rawCollection || "none";
        const tokenId = publicData.tokenId != null && publicData.tokenId !== "" ? String(publicData.tokenId).trim() : "";
        const currentOwner = normalizeAddress(publicData.owner);
        const updates = {};

        if (normalizedCollection && normalizedCollection !== "none" && rawCollection !== normalizedCollection) {
            updates.collection = normalizedCollection;
        }

        if (normalizedCollection && normalizedCollection !== "none" && tokenId) {
            try {
                const tokenOwner = await getTokenOwner(normalizedCollection, tokenId);
                if (tokenOwner && tokenOwner !== currentOwner) {
                    updates.owner = tokenOwner;
                }
            } catch (error) {
                stats.ownerLookupFailures += 1;
                console.error(`Token owner lookup failed for ${normalizedCollection}#${tokenId}: ${error.message || error}`);
            }
        } else if (
            normalizedCollection &&
            normalizedCollection !== "none" &&
            normalizedCollection !== defaultCollectionAddress
        ) {
            try {
                const collectionOwner = collectionOwners.get(normalizedCollection) || (await getCollectionOwner(normalizedCollection));
                if (collectionOwner) {
                    collectionOwners.set(normalizedCollection, collectionOwner);
                }
                if (collectionOwner && currentOwner && currentOwner.toLowerCase() !== collectionOwner.toLowerCase()) {
                    stats.unauthorizedDraftsFlagged += 1;
                    suspiciousDrafts.push({
                        id: pin.id,
                        collection: normalizedCollection,
                        owner: currentOwner,
                        expectedOwner: collectionOwner,
                    });

                    if (deleteUnauthorizedDrafts) {
                        await IPFS.deleteFiles([pin.id]);
                        stats.unauthorizedDraftsDeleted += 1;
                        continue;
                    }
                }
            } catch (error) {
                stats.ownerLookupFailures += 1;
                console.error(`Draft collection lookup failed for ${normalizedCollection}: ${error.message || error}`);
            }
        }

        if (Object.keys(updates).length > 0) {
            await IPFS.updateFileKeyvalues(pin.id, updates);
            stats.itemsUpdated += 1;
        }
    }

    console.log("\nReconciliation summary");
    console.log(JSON.stringify(stats, null, 2));

    if (suspiciousDrafts.length > 0) {
        console.log("\nSuspicious non-default drafts");
        for (const draft of suspiciousDrafts.slice(0, 25)) {
            console.log(`${draft.id} ${draft.collection} owner=${draft.owner} expectedOwner=${draft.expectedOwner}`);
        }
        if (suspiciousDrafts.length > 25) {
            console.log(`...and ${suspiciousDrafts.length - 25} more`);
        }
    }
}

main().catch((error) => {
    console.error("Reconciliation failed:", error.message || error);
    process.exit(1);
});
