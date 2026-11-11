const { Domain } = require("../modules/domain.class");
const { isRemovedDomain, omitRemovedDomain } = require("../../../Core/removed-blockdag");
const { initCacheInstance } = require("../../../cache/manager");
const { cache } = require("joi");
const axios = require("../../../Core/axios").getEncryptionInstance();
const IPFS = require("../../../Repositories/IPFS/modules/ipfs.module");

// Initialize cache for dynamic domains with 2 hour TTL (see cache/manager.js stdTTL)
const domainsCache = initCacheInstance();

/**
 * Supported Domains Configuration
 * This file defines all supported domain types and their configurations using Domain class instances
 *
 * Domain Configuration Structure:
 * - type: "official" | "custom" | "community" | "enterprise"
 * - price: Price in cents (0 = free)
 * - holdSuffix: Suffix for hold domains (e.g., ".hold")
 * - status: "active" | "inactive" | "maintenance" | "beta"
 * - owner: Domain owner identifier
 * - description: Human-readable description
 * - features: Array of supported features
 * - validation: Name validation rules
 * - storage: Storage configuration
 * - payment: Payment options and methods
 * - metadata: Additional domain-specific data
 */

const SUPPORTED_DOMAINS = {};

/**
 * Get domain configuration by domain name
 * @param {string} domain - Domain name (e.g., 'avax', 'btc')
 * @returns {Object|null} - Domain configuration or null if not found
 */
const getDomainConfig = (domain) => {
    if (!domain) return null;

    const supportedDomains = getSupportedDomains();

    const selectedDomain = supportedDomains[domain.toLowerCase()];

    const domainObject = selectedDomain ? new Domain(selectedDomain) : null;

    return domainObject;
};

/**
 * Check if domain is supported
 * @param {string} domain - Domain name
 * @returns {boolean} - True if domain is supported
 */
const isSupported = (domain) => {
    const supportedDomains = getSupportedDomains();
    return domain && supportedDomains.hasOwnProperty(domain.toLowerCase());
};

/**
 * Get all supported domains
 * @param {Array} licenses - Optional array of license objects
 * @returns {Object} - All supported domains
 */
const getAllSupportedDomains = (licenses = null, paid = false) => {
    const domains = getSupportedDomains(licenses);

    // TODO Miguel > I need to implement this better
    // if (paid) {
    // 	const paidDomains = {};

    // 	for (const domain in domains) {
    // 		if (domains[domain].stripe?.amountPaid > 0) {
    // 			paidDomains[domain] = domains[domain];
    // 		}
    // 	}

    // 	return paidDomains;
    // }

    return domains;
};

/**
 * Get domains by type
 * @param {string} type - Domain type ('official', 'custom', 'enterprise')
 * @returns {Array} - Array of domain configurations
 */
const getByType = (type) => {
    return Object.entries(getSupportedDomains())
        .filter(([_, config]) => config.type === type)
        .map(([domain, config]) => ({ domain, ...config }));
};

/**
 * Validate domain name against domain rules
 * @param {string} domain - Domain name
 * @param {string} name - Name to validate
 * @returns {Object} - Validation result
 */
const validateDomainName = (domain, name) => {
    const config = getDomainConfig(domain);

    if (!config) return { valid: false, error: "Domain not supported" };

    // Check length
    if (name.length < config.tags.minLength) {
        return { valid: false, error: `Name must be at least ${config.tags.minLength} characters` };
    }

    if (name.length > config.tags.maxLength) {
        return { valid: false, error: `Name must be no more than ${config.tags.maxLength} characters` };
    }

    // Check reserved names
    if (config.tags.reserved.includes(name.toLowerCase())) {
        return { valid: false, error: "Name is reserved" };
    }

    return { valid: true };
};

/**
 * Check if domain is active
 * @param {string} domain - Domain name
 * @returns {boolean} - True if domain is active
 */
const isDomainActive = (domain) => {
    const config = getDomainConfig(domain);

    return config && config.status === "active";
};

/**
 * Get active domains only
 * @returns {Array} - Array of active domain configurations
 */
const getActiveDomains = () => {
    return Object.entries(getSupportedDomains())
        .filter(([_, config]) => config.status === "active")
        .map(([domain, config]) => ({ domain, ...config }));
};

/**
 * Get domains by owner
 * @param {string} owner - Domain owner
 * @returns {Array} - Array of domain configurations
 */
const getByOwner = (owner) => {
    return Object.entries(getSupportedDomains())
        .filter(([_, config]) => config.owner === owner)
        .map(([domain, config]) => ({ domain, ...config }));
};

/**
 * Check if domain supports feature
 * @param {string} domain - Domain name
 * @param {string} feature - Feature name
 * @returns {boolean} - True if feature is supported
 */
const supportsFeature = (domain, feature) => {
    const config = getDomainConfig(domain);
    return config && config.features && config.features.includes(feature);
};

/**
 * Get domain storage configuration
 * @param {string} domain - Domain name
 * @returns {Object} - Storage configuration
 */
const getDomainStorageConfig = (domain) => {
    const config = getDomainConfig(domain);
    return (
        config?.storage || {
            keyPrefix: "tagName",
            ipfsEnabled: true,
            arweaveEnabled: true,
            walrusEnabled: true,
            backupEnabled: false,
        }
    );
};

/**
 * Generate hold domain name
 * @param {string} domain - Domain name
 * @param {string} name - Tag name
 * @returns {string} - Hold domain name
 */
const generateHoldDomain = (domain, name) => {
    const config = getDomainConfig(domain);
    const holdSuffix = config?.holdSuffix || ".hold";
    return `${name}${holdSuffix}.${domain}`;
};

/**
 * Get domain payment methods
 * @param {string} domain - Domain name
 * @returns {Array} - Array of payment methods
 */
const getDomainPaymentMethods = (domain) => {
    const config = getDomainConfig(domain);
    return config?.payment?.methods || ["crypto", "stripe"];
};

/**
 * Get domain currencies
 * @param {string} domain - Domain name
 * @returns {Array} - Array of supported currencies
 */
const getDomainCurrencies = (domain) => {
    const config = getDomainConfig(domain);
    return config?.payment?.currencies || ["USD"];
};

/**
 * Get domain limits
 * @param {string} domain - Domain name
 * @returns {Object} - Domain limits
 */
const getDomainLimits = (domain) => {
    const config = getDomainConfig(domain);
    return (
        config?.limits || {
            maxTagsPerUser: 5,
            maxTransferPerDay: 3,
            maxRenewalPerDay: 2,
        }
    );
};

/**
 * Load domains from cache
 * @returns {Object|null} - Cached domains or null if not found/expired
 */
const loadCache = () => {
    try {
        const cached = domainsCache.get("official-licenses");

        if (cached) {
            console.info("Loading dynamic domains from memory cache");
            return cached;
        }
        return null;
    } catch (error) {
        console.error("Error loading from cache:", error);
        return null;
    }
};

/**
 * Save domains to cache
 * @param {Object} domains - Domain objects to cache
 */
const saveCache = (domains) => {
    try {
        // Check if we need to update the cache (avoid unnecessary operations)
        const existingCache = loadCache();

        if (existingCache && JSON.stringify(existingCache) === JSON.stringify(domains)) {
            return;
        }

        // Save to memory cache with automatic expiration
        domainsCache.set("official-licenses", domains);
    } catch (error) {
        console.error("Error saving to cache:", error);
    }
};

/**
 * Load license JSON from IPFS URL
 * @param {string} ipfsUrl - IPFS URL to fetch JSON from
 * @returns {Object} - License JSON data
 */
const _loadLicenseJSON = async (ipfsUrl) => {
    const jsonData = await axios.get(ipfsUrl);
    return jsonData.data;
};

/**
 * Load dynamic domains from provided licenses data or fetch from IPFS
 * @param {Array} licenses - Optional array of license objects
 * @param {boolean} force - Force reload from IPFS, bypassing cache
 * @returns {Object|null} - Dynamic domains object or null if not available
 */
const loadDynamicDomains = async (licenses = null, force = false) => {
    // Try to get from cache first (unless forced)
    if (!force) {
        const cachedData = loadCache();
        if (cachedData) return cachedData;
    }

    // If licenses are provided, use them to create domains
    if (licenses && Array.isArray(licenses)) {
        try {
            // Convert license data to Domain objects
            const dynamicDomains = {};

            for (const license of licenses) {
                if (license.name && !isRemovedDomain(license.name)) {
                    dynamicDomains[license.name.toLowerCase()] = new Domain(license);
                }
            }

            // Cache the result with automatic expiration
            saveCache(dynamicDomains);

            return dynamicDomains;
        } catch (error) {
            console.warn("Failed to process provided licenses:", error.message);
        }
    }

    // If no licenses provided or processing failed, try fetching from IPFS
    try {
        // Fetch from IPFS
        const officialLicenses = await IPFS.get({ key: "type", value: "license" });

        const dynamicDomains = {};

        for (const license of officialLicenses) {
            try {
                const licenseData = await _loadLicenseJSON(license.url);
                if (licenseData.name && !isRemovedDomain(licenseData.name)) {
                    dynamicDomains[licenseData.name.toLowerCase()] = new Domain(licenseData);
                }
            } catch (error) {
                console.error(`Error loading license ${license.id}:`, error.message);
                // Continue with other licenses
            }
        }

        // Save to cache with automatic expiration
        saveCache(dynamicDomains);

        console.info(`Loaded ${Object.keys(dynamicDomains).length} dynamic domains from IPFS successfully`);

        return dynamicDomains;
    } catch (error) {
        console.error("Error loading dynamic domains from IPFS:", error);

        // Try to return cached data as fallback
        const fallbackCache = loadCache();
        if (fallbackCache) {
            console.warn("Using cached domains as fallback");
            return fallbackCache;
        }

        return null;
    }
};

const getSupportedDomains = (licenses = null) => {
    try {
        // When licenses are provided (from loadOfficialLicenses), use them first so
        // fresh data (e.g. metadata.logo) is not overridden by stale domains cache
        const licenseList = Array.isArray(licenses) ? licenses : licenses && typeof licenses === "object" ? Object.values(licenses) : null;

        if (licenseList && licenseList.length > 0) {
            const dynamicDomains = {};
            for (const license of licenseList) {
                if (license && license.name && !isRemovedDomain(license.name)) {
                    dynamicDomains[license.name.toLowerCase()] = new Domain(license);
                }
            }
            if (Object.keys(dynamicDomains).length > 0) {
                saveCache(dynamicDomains);
                return omitRemovedDomain({ ...SUPPORTED_DOMAINS, ...dynamicDomains });
            }
        }

        // Fall back to cache when no licenses provided
        const cachedDomains = loadCache();
        if (cachedDomains) {
            return omitRemovedDomain({ ...SUPPORTED_DOMAINS, ...cachedDomains });
        }

        // If no cache and no licenses provided, trigger async fetch in background
        // but return static domains immediately for this call
        // The cache will be populated for subsequent calls
        loadDynamicDomains(null, false).catch((error) => {
            console.error("Background fetch of domains failed:", error);
        });
    } catch (error) {
        console.warn("Error loading dynamic domains:", error.message);
    }

    return omitRemovedDomain(SUPPORTED_DOMAINS);
};

const isWalrusStorageSupported = (domain, app) => {
    const config = getDomainConfig(domain);

    if (!config) return false;

    return Boolean(config[app]?.storage?.walrusEnabled);
};

const isIPFSStorageSupported = (domain, app) => {
    const config = getDomainConfig(domain);

    if (!config) return false;

    return Boolean(config[app]?.storage?.ipfsEnabled);
};

const isArweaveStorageSupported = (domain, app) => {
    const config = getDomainConfig(domain);

    if (!config) return false;

    return Boolean(config[app]?.storage?.arweaveEnabled);
};

module.exports = {
    getSupportedDomains,
    getDomainConfig,
    isSupported,
    isDomainActive,
    getAllSupportedDomains,
    getByType,
    getActiveDomains,
    getByOwner,
    supportsFeature,
    getDomainStorageConfig,
    generateHoldDomain,
    getDomainPaymentMethods,
    getDomainCurrencies,
    getDomainLimits,
    validateDomainName,
    loadDynamicDomains,
    isWalrusStorageSupported,
    isIPFSStorageSupported,
    isArweaveStorageSupported,
};
