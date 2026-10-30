const { addressLookupValues } = require("./ton-address-lookup.util");
const TagsIPFSModule = require("./tags-ipfs.module");
const TagsArweaveModule = require("./tags-arweave.module");
const { getDomainConfiguration, isDomainActive } = require("./domain-registry.module");
const TagsPartsModule = require("./tags-parts.module");
const TagAddressIndexModule = require("./tag-address-index.module");
const { QRZelfProofExtractor, generateQRFromZelfProof } = require("./qr-zelfproof-extractor.module");

const DEFAULT_IPFS_TIMEOUT_MS = Number(process.env.TAGS_SEARCH_IPFS_TIMEOUT_MS) || 12000;
const DEFAULT_ARWEAVE_TIMEOUT_MS = Number(process.env.TAGS_SEARCH_ARWEAVE_TIMEOUT_MS) || 3000;
const ARWEAVE_FAST_GRACE_MS = Number(process.env.TAGS_SEARCH_ARWEAVE_FAST_GRACE_MS) || 500;

/**
 * Tags Search Module
 *
 * This module handles search operations for the Tags system with multi-domain support.
 * It provides unified search functionality across IPFS and Arweave for different domain types.
 */

/**
 * Search for tags across IPFS and Arweave
 * @param {Object} params - Search parameters
 * @param {string} params.tagName - Tag name (e.g., "username.avax")
 * @param {string} params.domain - Domain name (e.g., "avax")
 * @param {string} params.key - Search key
 * @param {string} params.value - Search value
 * @param {Object} authUser - Authenticated user
 * @returns {Object} - Search results
 */
const searchTag = async (params, authUser) => {
    params = { ...params, environment: params.environment || "all", type: params.type || "both" };
    const { tagName, domain, key, value, environment, type, duration } = params;

    let domainConfig = params.domainConfig || getDomainConfiguration(domain);

    try {
        if (!domainConfig) throw new Error("domain_configuration_unavailable");
        /**
         * Si la busqueda en IPFS se pasa del tiempo o falla, devuelve una lista vacia.
         * Eso antes se confundia con "el nombre no existe" y se respondia que estaba
         * disponible aunque ya estuviera registrado: es lo que reporto QA cuando una
         * wallet creada en Android aparecia como libre desde iOS.
         */
        let ipfsIncompleto = false;
        let arweaveIncompleto = false;

        const shouldSearchIpfs = ["ipfs", "all"].includes(environment) && Boolean(domainConfig.tags?.storage?.ipfsEnabled);
        const shouldSearchArweave =
            ["arweave", "all"].includes(environment) &&
            ["both", "mainnet"].includes(type) &&
            Boolean(domainConfig.tags?.storage?.arweaveEnabled);

        let ipfsRaw = [];
        let arweaveResults = [];

        if (shouldSearchIpfs && shouldSearchArweave) {
            // Concurrently start both IPFS and Arweave searches
            const ipfsPromise = searchWithTimeout(searchIPFS(params, authUser), DEFAULT_IPFS_TIMEOUT_MS, "IPFS", () => {
                ipfsIncompleto = true;
            });
            const arweavePromise = searchWithTimeout(searchArweave(params, authUser), DEFAULT_ARWEAVE_TIMEOUT_MS, "Arweave", () => {
                arweaveIncompleto = true;
            });

            // Wait for IPFS first
            ipfsRaw = await ipfsPromise;

            // If IPFS returned records, we already have our tag!
            // Do not block on slow Arweave: give Arweave at most a short grace window, otherwise return IPFS immediately.
            // An address-index check needs the Arweave copy: legacy TON/DOT/KSM only live there.
            if (ipfsRaw && ipfsRaw.length > 0 && !params._waitForArweave) {
                let fastGraceTimer;
                const fastGracePromise = new Promise((resolve) => {
                    fastGraceTimer = setTimeout(() => resolve(null), ARWEAVE_FAST_GRACE_MS);
                    if (fastGraceTimer && typeof fastGraceTimer.unref === "function") fastGraceTimer.unref();
                });
                const fastArweave = await Promise.race([arweavePromise, fastGracePromise]);
                if (fastGraceTimer) clearTimeout(fastGraceTimer);
                arweaveResults = fastArweave !== null ? fastArweave : [];
            } else {
                // If IPFS found nothing, wait for Arweave up to its full timeout to check if the tag is on Arweave
                arweaveResults = await arweavePromise;
            }
        } else if (shouldSearchIpfs) {
            ipfsRaw = await searchWithTimeout(searchIPFS(params, authUser), DEFAULT_IPFS_TIMEOUT_MS, "IPFS", () => {
                ipfsIncompleto = true;
            });
        } else if (shouldSearchArweave) {
            arweaveResults = await searchWithTimeout(searchArweave(params, authUser), DEFAULT_ARWEAVE_TIMEOUT_MS, "Arweave", () => {
                arweaveIncompleto = true;
            });
        }

        const ipfsResults = TagsIPFSModule.sortDedupeIpfsSearchResults(ipfsRaw);

        const hasAnyResult = ipfsResults.length > 0 || arweaveResults.length > 0;
        const ipfsCompleted = shouldSearchIpfs && !ipfsIncompleto;
        const arweaveCompleted = shouldSearchArweave && !arweaveIncompleto;
        const anyStoreCompleted = ipfsCompleted || arweaveCompleted;
        const noStoresEnabled = !shouldSearchIpfs && !shouldSearchArweave;
        // SourceA OR SourceB: incomplete only when no enabled store completed successfully.
        const isIncomplete = !hasAnyResult && (noStoresEnabled || !anyStoreCompleted);

        if (hasAnyResult) {
            TagAddressIndexModule.indexRecords(ipfsResults, { domain, source: "ipfs" });
            TagAddressIndexModule.indexRecords(arweaveResults, { domain, source: "arweave" });
        } else if (key && value && !tagName && TagAddressIndexModule.supportsKey(key)) {
            const viaIndex = await resolveByAddressIndex(params, authUser);
            if (viaIndex) return viaIndex;
        }

        // Combine results
        const combinedResults = {
            ipfs: ipfsResults,
            arweave: arweaveResults,
            available: !hasAnyResult && !isIncomplete,
            searchIncomplete: isIncomplete || undefined,
            tagName,
            domain,
        };

        // Assign tagObject: prioritize IPFS as canonical source of truth; Arweave is archival / fallback
        if (ipfsResults.length > 0) {
            combinedResults.tagObject = { ...ipfsResults[0] };
            combinedResults.tagObject.ipfsId = ipfsResults[0].id;
            const ipfsUrl = typeof ipfsResults[0].url === "string" && ipfsResults[0].url.trim() !== "" ? ipfsResults[0].url.trim() : "";
            if (ipfsUrl) combinedResults.tagObject.ipfsContentUrl = ipfsUrl;

            // Having two copies is nice, but not required: enrich with Arweave metadata if present
            if (arweaveResults.length > 0) {
                const arPd = arweaveResults[0].publicData || {};
                const ipfsPd = combinedResults.tagObject.publicData || {};

                combinedResults.tagObject.publicData = { ...arPd, ...ipfsPd };
                if (arweaveResults[0].id) combinedResults.tagObject.arweaveId = arweaveResults[0].id;
                if (arweaveResults[0].url) combinedResults.tagObject.arweaveUrl = arweaveResults[0].url;
            }
        } else if (arweaveResults.length > 0) {
            // Only Arweave copy is available (one copy is enough)
            combinedResults.tagObject = { ...arweaveResults[0] };
        }

        if (combinedResults.tagObject) {
            combinedResults.tagObject.publicData = TagAddressIndexModule.hydrateMissingAddresses(
                { ...(combinedResults.tagObject.publicData || {}) },
                [...ipfsResults, ...arweaveResults]
            );
            if (
                (!combinedResults.tagObject.publicData.aptosAddress ||
                    !combinedResults.tagObject.publicData.dotAddress ||
                    !combinedResults.tagObject.publicData.ksmAddress) &&
                typeof TagsIPFSModule.hydrateContinuationAddresses === "function"
            ) {
                combinedResults.tagObject.publicData =
                    (await TagsIPFSModule.hydrateContinuationAddresses(combinedResults.tagObject.publicData)) ||
                    combinedResults.tagObject.publicData;
            }
        }

        if (combinedResults.available && domainConfig) {
            combinedResults.price = domainConfig.getPrice(tagName, duration);
        }

        if (combinedResults.tagObject && combinedResults.tagObject.publicData?.zelfProof) {
            combinedResults.tagObject.zelfProof = combinedResults.tagObject.publicData.zelfProof;
        }

        if (combinedResults.tagObject && !combinedResults.tagObject?.zelfProofQRCode) {
            combinedResults.tagObject.zelfProofQRCode = await TagsPartsModule.urlToBase64First([
                combinedResults.tagObject.ipfsContentUrl,
                combinedResults.tagObject.url,
                combinedResults.tagObject.arweaveUrl,
            ]);
        }

        if (combinedResults.tagObject && !combinedResults.tagObject?.zelfProofQRCode && combinedResults.tagObject.zelfProof) {
            const regenerated = await generateQRFromZelfProof(combinedResults.tagObject.zelfProof);

            if (regenerated) combinedResults.tagObject.zelfProofQRCode = regenerated;
        }

        if (combinedResults.tagObject && combinedResults.tagObject.zelfProofQRCode && !combinedResults.tagObject.zelfProof) {
            try {
                const extractedZelfProof = await QRZelfProofExtractor.extractZelfProof(combinedResults.tagObject.zelfProofQRCode);

                if (extractedZelfProof && QRZelfProofExtractor.validateZelfProof(extractedZelfProof)) {
                    combinedResults.tagObject.zelfProof = extractedZelfProof;
                }
            } catch (error) {
                console.error({ searchTag_error: error });
            }
        }

        const { readLeaseSearchResult } = require("../../ZelfID/modules/zelf-id-plan-term.module");
        return readLeaseSearchResult(combinedResults);
    } catch (error) {
        console.error({ searchTag_error: error });

        return {
            available: false,
            searchIncomplete: true,
            error: error.message,
            tagName,
            domain,
        };
    }
};

/**
 * Packed addresses (TON, Aptos, DOT, KSM...) of legacy records are invisible to a
 * key/value search. The index only proposes a name; the answer is the live record,
 * and only if it still registers this exact address (#540).
 */
const resolveByAddressIndex = async (params, authUser) => {
    const { key, value } = params;
    const candidates = await TagAddressIndexModule.findTagNames(key, value);

    for (const candidate of candidates) {
        const byName = await searchTag(
            { ...params, tagName: candidate, key: undefined, value: undefined, _waitForArweave: true },
            authUser
        );
        const record = byName?.tagObject;

        if (!record || !TagAddressIndexModule.recordHasAddress(record.publicData, key, value)) continue;

        const field = TagAddressIndexModule.canonicalKey(key);
        if (field !== key && record.publicData[field] && !record.publicData[key]) record.publicData[key] = record.publicData[field];

        return { ...byName, resolvedBy: "addressIndex" };
    }

    return null;
};

/**
 * Search for tags in IPFS
 * @param {Object} params - Search parameters
 * @param {Object} authUser - Authenticated user
 * @returns {Array} - IPFS search results
 */
const searchIPFS = async (params, authUser) => {
    const { tagName, key, value, type, domain, includeAllAddressPages } = params;

    const domainConfig = params.domainConfig || getDomainConfiguration(domain);

    if (!domainConfig?.tags?.storage?.ipfsEnabled) {
        return [];
    }

    const ipfsRecords = [];

    const _tagName = tagName ? TagsPartsModule.getFullTagName(tagName, domainConfig.name) : tagName;

    try {
        switch (type) {
            case "hold": {
                const holdRecords = await TagsIPFSModule.get({ tagName: `${_tagName}.hold`, key, value, domainConfig, includeAllAddressPages });
                ipfsRecords.push(...holdRecords);
                break;
            }
            case "mainnet": {
                const mainnetRecords = await TagsIPFSModule.get({ tagName: _tagName, key, value, domainConfig, includeAllAddressPages });
                ipfsRecords.push(...mainnetRecords);
                break;
            }
            case "both":
            default: {
                const [mainnetRecords, holdRecords] = await Promise.all([
                    TagsIPFSModule.get({ tagName: _tagName, key, value, domainConfig, includeAllAddressPages }),
                    TagsIPFSModule.get({ tagName: `${_tagName}.hold`, key, value, domainConfig, includeAllAddressPages }),
                ]);
                ipfsRecords.push(...mainnetRecords, ...holdRecords);
                break;
            }
        }

        return ipfsRecords;
    } catch (error) {
        console.error("Error searching IPFS:", error);
        throw error;
    }
};

/**
 * Search for tags in Arweave
 * @param {Object} params - Search parameters
 * @param {Object} authUser - Authenticated user
 * @returns {Array} - Arweave search results
 */
const searchArweave = async (params, authUser) => {
    try {
        const { tagName, domain, key, value, domainConfig } = params;

        // Get domain configuration
        const _domainConfig = domainConfig || getDomainConfiguration(domain);

        if (!_domainConfig?.tags?.storage?.arweaveEnabled) return [];

        // Search by different criteria (only resolve full tagName when searching by tagName)
        if (tagName) {
            const _tagName = TagsPartsModule.getFullTagName(tagName, _domainConfig.name);
            return TagsArweaveModule.searchByStorageKey({ tagName: _tagName, domainConfig: _domainConfig, domain });
        }

        if (key && value) {
            const values = addressLookupValues(key, value);
            return (await Promise.all(values.map((address) =>
                TagsArweaveModule.searchByStorageKey({ key, value: address, domainConfig: _domainConfig, domain })
            ))).flat();
        }

        // Search by domain
        return TagsArweaveModule.searchByStorageKey({ key: "domain", value: domain, domainConfig: _domainConfig }, authUser);
    } catch (error) {
        console.error("Error searching Arweave:", error);
        throw error;
    }
};

/**
 * Search for hold domains
 * @param {Object} params - Search parameters
 * @param {string} params.domain - Domain name
 * @param {string} params.name - Tag name
 * @param {Object} authUser - Authenticated user
 * @returns {Object} - Hold domain search results
 */
const searchHoldDomain = async (params, authUser) => {
    const { domain, name } = params;

    // Validate domain
    if (!isDomainActive(domain)) {
        return {
            available: false,
            error: `Domain '${domain}' is not active`,
            domain,
            name,
        };
    }

    try {
        // Search for hold domain in both IPFS and Arweave
        const [ipfsResults, arweaveResults] = await Promise.all([
            searchWithTimeout(TagsIPFSModule.getHoldDomain({ domain, name }, authUser), DEFAULT_IPFS_TIMEOUT_MS, "IPFS"),
            searchWithTimeout(TagsArweaveModule.getHoldDomain({ domain, name }, authUser), DEFAULT_ARWEAVE_TIMEOUT_MS, "Arweave"),
        ]);

        // Combine results
        const combinedResults = {
            ipfs: ipfsResults,
            arweave: arweaveResults,
            available: ipfsResults.length === 0 && arweaveResults.length === 0,
            domain,
            name,
        };

        // If results found, return the first one
        if (ipfsResults.length > 0) {
            combinedResults.holdObject = ipfsResults[0];
        } else if (arweaveResults.length > 0) {
            combinedResults.holdObject = arweaveResults[0];
        }

        return combinedResults;
    } catch (error) {
        console.error("Error searching hold domain:", error);

        return {
            available: false,
            error: error.message,
            domain,
            name,
        };
    }
};

/**
 * Search for tags by domain
 * @param {Object} params - Search parameters
 * @param {string} params.domain - Domain name
 * @param {string} params.key - Search key
 * @param {string} params.value - Search value
 * @param {Object} authUser - Authenticated user
 * @returns {Object} - Domain search results
 */
const searchByDomain = async (params, authUser) => {
    const { domain, storage, limit, pageOffset, name } = params;

    // Validate domain
    if (!isDomainActive(domain)) {
        return {
            available: false,
            error: `Domain '${domain}' is not active`,
            domain,
        };
    }

    switch (storage) {
        case "IPFS":
            return await TagsIPFSModule.searchByDomain({ domain, limit, pageOffset, name }, authUser);
        case "Arweave": {
            const rows = await TagsArweaveModule.searchByDomain({ domain }, authUser);
            const allRows = Array.isArray(rows) ? rows : [];
            const resolvedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
            const resolvedOffset = Math.max(parseInt(pageOffset, 10) || 0, 0);
            return {
                rows: allRows.slice(resolvedOffset, resolvedOffset + resolvedLimit),
                total: allRows.length,
                limit: resolvedLimit,
                pageOffset: resolvedOffset,
            };
        }
        default:
            return {
                rows: [],
                total: 0,
                limit: parseInt(limit, 10) || 50,
                pageOffset: parseInt(pageOffset, 10) || 0,
            };
    }
};

/**
 * Search for tags by storage key
 * @param {Object} params - Search parameters
 * @param {string} params.domain - Domain name
 * @param {string} params.name - Tag name
 * @param {Object} authUser - Authenticated user
 * @returns {Object} - Storage key search results
 */
const searchByStorageKey = async (params, authUser) => {
    const { domain, name } = params;

    // Validate domain
    if (!isDomainActive(domain)) {
        return {
            available: false,
            error: `Domain '${domain}' is not active`,
            domain,
            name,
        };
    }

    try {
        // Search in both IPFS and Arweave
        const [ipfsResults, arweaveResults] = await Promise.all([
            searchWithTimeout(TagsIPFSModule.searchByStorageKey({ domain, name }, authUser), DEFAULT_IPFS_TIMEOUT_MS, "IPFS"),
            searchWithTimeout(TagsArweaveModule.searchByStorageKey({ domain, name }, authUser), DEFAULT_ARWEAVE_TIMEOUT_MS, "Arweave"),
        ]);

        // Combine results
        const combinedResults = {
            ipfs: ipfsResults,
            arweave: arweaveResults,
            available: ipfsResults.length === 0 && arweaveResults.length === 0,
            domain,
            name,
        };

        // If results found, return the first one
        if (ipfsResults.length > 0) {
            combinedResults.tagObject = ipfsResults[0];
            const ipfsUrl = typeof ipfsResults[0].url === "string" && ipfsResults[0].url.trim() !== "" ? ipfsResults[0].url.trim() : "";
            if (ipfsUrl) combinedResults.tagObject.ipfsContentUrl = ipfsUrl;
        } else if (arweaveResults.length > 0) {
            combinedResults.tagObject = arweaveResults[0];
        }

        if (combinedResults.tagObject && combinedResults.tagObject.publicData?.zelfProof) {
            combinedResults.tagObject.zelfProof = combinedResults.tagObject.publicData.zelfProof;
        }

        if (combinedResults.tagObject && !combinedResults.tagObject?.zelfProofQRCode) {
            combinedResults.tagObject.zelfProofQRCode = await TagsPartsModule.urlToBase64First([
                combinedResults.tagObject.url,
                combinedResults.tagObject.ipfsContentUrl,
            ]);
        }

        if (combinedResults.tagObject && !combinedResults.tagObject?.zelfProofQRCode && combinedResults.tagObject.zelfProof) {
            const regenerated = await generateQRFromZelfProof(combinedResults.tagObject.zelfProof);

            if (regenerated) combinedResults.tagObject.zelfProofQRCode = regenerated;
        }

        if (combinedResults.tagObject && combinedResults.tagObject.zelfProofQRCode && !combinedResults.tagObject.zelfProof) {
            const extractedZelfProof = await QRZelfProofExtractor.extractZelfProof(combinedResults.tagObject.zelfProofQRCode);
            if (extractedZelfProof && QRZelfProofExtractor.validateZelfProof(extractedZelfProof)) {
                combinedResults.tagObject.zelfProof = extractedZelfProof;
            }
        }

        return combinedResults;
    } catch (error) {
        return {
            available: false,
            error: error.message,
            domain,
            name,
        };
    }
};

/**
 * Get domain statistics
 * @param {string} domain - Domain name
 * @param {Object} authUser - Authenticated user
 * @returns {Object} - Domain statistics
 */
const getDomainStats = async (domain, authUser) => {
    try {
        // Get statistics from both IPFS and Arweave
        const [ipfsStats, arweaveStats] = await Promise.all([
            searchWithTimeout(TagsIPFSModule.getDomainStats(domain, authUser), DEFAULT_IPFS_TIMEOUT_MS, "IPFS"),
            searchWithTimeout(TagsArweaveModule.getDomainStats(domain, authUser), DEFAULT_ARWEAVE_TIMEOUT_MS, "Arweave"),
        ]);

        // Combine statistics
        const combinedStats = {
            domain,
            totalTags: (ipfsStats.totalTags || 0) + (arweaveStats.totalTags || 0),
            holdDomains: (ipfsStats.holdDomains || 0) + (arweaveStats.holdDomains || 0),
            activeTags: (ipfsStats.activeTags || 0) + (arweaveStats.activeTags || 0),
            ipfsStats: ipfsStats,
            arweaveStats: arweaveStats,
        };

        return combinedStats;
    } catch (error) {
        console.error("Error getting domain stats:", error);
        return {
            domain,
            totalTags: 0,
            holdDomains: 0,
            activeTags: 0,
            error: error.message,
        };
    }
};

/**
 * Search for tags across all domains
 * @param {Object} params - Search parameters
 * @param {string} params.key - Search key
 * @param {string} params.value - Search value
 * @param {Object} authUser - Authenticated user
 * @returns {Object} - Cross-domain search results
 */
const searchAllDomains = async (params, authUser) => {
    const { key, value } = params;

    try {
        // Get all active domains
        const activeDomains = require("../config/supported-domains").getActiveDomains();

        // Search across all domains
        const domainSearches = activeDomains.map((domain) => searchByDomain({ domain: domain.domain, key, value }, authUser));

        const results = await Promise.all(domainSearches);

        // Combine all results
        const combinedResults = {
            domains: results,
            totalDomains: activeDomains.length,
            totalResults: results.reduce((sum, result) => sum + (result.totalResults || 0), 0),
        };

        return combinedResults;
    } catch (error) {
        console.error("Error searching all domains:", error);
        return {
            domains: [],
            totalDomains: 0,
            totalResults: 0,
            error: error.message,
        };
    }
};

/**
 * Helper to wrap a promise with a timeout
 */
const searchWithTimeout = async (promise, ms, name, onError) => {
    let timeoutId;
    try {
        const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
                reject(new Error("SEARCH_TIMEOUT"));
            }, ms);
            if (timeoutId && typeof timeoutId.unref === "function") timeoutId.unref();
        });

        // Use Promise.race to race the actual search against the timeout
        const result = await Promise.race([promise, timeoutPromise]);

        clearTimeout(timeoutId);
        return result;
    } catch (error) {
        if (timeoutId) clearTimeout(timeoutId);

        // El llamador necesita distinguir "no hay resultados" de "la busqueda fallo":
        // con la lista vacia a secas, un nombre ya registrado se reportaba disponible.
        if (typeof onError === "function") onError(error);

        if (error.message === "SEARCH_TIMEOUT") {
            console.warn(`${name} search timed out after ${ms}ms - continuing with other results`);
            // Return empty array to allow other search results (e.g. Arweave) to be used
            return [];
        }
        // If it's a real error from the search function, we might want to log it but still return empty
        // so we don't block the entire request
        console.error(`${name} search error:`, error.message);
        return [];
    }
};

module.exports = {
    searchTag,
    searchIPFS,
    searchArweave,
    searchHoldDomain,
    searchByDomain,
    searchByStorageKey,
    getDomainStats,
    searchAllDomains,
};
