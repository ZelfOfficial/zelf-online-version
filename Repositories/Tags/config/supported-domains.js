const config = require("../../../Core/config");
const { Domain } = require("../modules/domain.class");
const { initCacheInstance } = require("../../../cache/manager");
const { cache } = require("joi");
const axios = require("../../../Core/axios").getEncryptionInstance();
const IPFS = require("../../../Repositories/IPFS/modules/ipfs.module");
const { asLicenseJson, mergeLicenseMap, preferLicense } = require("../../License/modules/license-cache.util");

// Initialize cache for dynamic domains with 2 hour TTL (see cache/manager.js stdTTL)
const domainsCache = initCacheInstance();

// Own key: License module stores raw license JSON under "official-licenses" in the same NodeCache.
const CACHE_KEY = "official-license-domains";

/**
 * Licenses are per-process memory; a save only refreshes the process that handled it.
 * A short TTL makes every other worker re-read Pinata soon (stale-while-revalidate keeps
 * serving the last licenses during the reload). Override with LICENSE_CACHE_TTL_SECONDS.
 */
const LICENSE_CACHE_TTL_SECONDS = Math.max(5, Number(process.env.LICENSE_CACHE_TTL_SECONDS) || 60);

/** After a reload fails or comes back empty, background lookups wait this long before retrying. */
const RELOAD_RETRY_MS = 30 * 1000;

/**
 * Stale-while-revalidate state, per process (each pm2 worker has its own).
 * When the cache entry expires, lookups keep the last licenses this worker saw while ONE
 * reload refreshes them: handing out the empty static list made every endpoint answer
 * "domain not supported" or empty data until the reload landed.
 */
let lastKnownDomains = null;
let reloadInFlight = null;
let nextBackgroundReloadAt = 0;

const _hasDomains = (domains) => Boolean(domains && typeof domains === "object" && Object.keys(domains).length > 0);

const _rememberDomains = (domains) => {
    if (_hasDomains(domains)) lastKnownDomains = domains;
    return domains;
};

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
        const cached = domainsCache.get(CACHE_KEY);

        // An empty map is a miss: it must never hide the last known licenses.
        if (_hasDomains(cached)) return _rememberDomains(cached);

        return null;
    } catch (error) {
        console.error("Error loading from cache:", error);
        return null;
    }
};

/**
 * Replace one domain in the in-memory official-licenses cache after a license save.
 * Pinata search lags; checkout must not wait on a 2-hour TTL.
 * @param {Object} licenseData - License JSON (same shape as IPFS domain file)
 */
const upsertCachedDomain = (licenseData) => {
    if (!licenseData?.name) return;

    try {
        const key = String(licenseData.name).toLowerCase();
        // After expiry start from the last known map, or the cache would hold this domain only.
        const cached = loadCache() || { ...(lastKnownDomains || {}) };
        const chosen = asLicenseJson(preferLicense(cached[key], licenseData));
        cached[key] = new Domain(chosen);
        domainsCache.set(CACHE_KEY, cached, LICENSE_CACHE_TTL_SECONDS);
        _rememberDomains(cached);
    } catch (error) {
        console.error("Error upserting cached domain:", error);
    }
};

/**
 * Save domains to cache
 * @param {Object} domains - Domain objects to cache
 */
const saveCache = (domains) => {
    // Never replace known licenses with an empty map (e.g. Pinata answering an empty list).
    if (!_hasDomains(domains)) return;

    try {
        // Always set, even when the data is identical: set() is what restarts the TTL. Skipping
        // identical saves made the licenses expire two hours after their last change.
        domainsCache.set(CACHE_KEY, domains, LICENSE_CACHE_TTL_SECONDS);
        _rememberDomains(domains);
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
                if (license.name) {
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

    // If no licenses provided or processing failed, reload from IPFS (one shared reload)
    return _reloadFromIpfs();
};

/**
 * Reloads the licenses from IPFS. Concurrent callers share the reload in flight instead of
 * each starting their own. Never rejects: on failure, or when nothing comes back, it resolves
 * with the last known domains (or null when this process never loaded any).
 * @returns {Promise<Object|null>}
 */
const _reloadFromIpfs = () => {
    if (reloadInFlight) return reloadInFlight;

    const reload = (async () => {
        try {
            const officialLicenses = await IPFS.get({ key: "type", value: "license" });

            const incoming = [];
            for (const license of officialLicenses || []) {
                try {
                    const licenseData = await _loadLicenseJSON(license.url);
                    if (licenseData.name) incoming.push(licenseData);
                } catch (error) {
                    console.error(`Error loading license ${license.id}:`, error.message);
                }
            }

            // Nothing came back (Pinata hiccup): not a successful reload. Keep the last known
            // licenses without restarting their TTL, and retry soon.
            if (!incoming.length) {
                console.warn("License reload returned no licenses; keeping the last known licenses");
                nextBackgroundReloadAt = Date.now() + RELOAD_RETRY_MS;
                return loadCache() || lastKnownDomains;
            }

            const existingJson = {};
            for (const [name, domain] of Object.entries(loadCache() || lastKnownDomains || {})) {
                existingJson[name] = asLicenseJson(domain);
            }
            const merged = mergeLicenseMap(existingJson, incoming);

            const dynamicDomains = {};
            for (const [name, license] of Object.entries(merged)) {
                dynamicDomains[name] = new Domain(license);
            }

            saveCache(dynamicDomains);
            nextBackgroundReloadAt = 0;

            console.info(`Loaded ${Object.keys(dynamicDomains).length} dynamic domains from IPFS successfully`);

            return dynamicDomains;
        } catch (error) {
            console.error("Error loading dynamic domains from IPFS:", error?.message || error);
            nextBackgroundReloadAt = Date.now() + RELOAD_RETRY_MS;

            const fallback = loadCache() || lastKnownDomains;
            if (fallback) console.warn("Using the last known domains as fallback");

            return fallback || null;
        }
    })();

    reloadInFlight = reload;
    const clear = () => {
        if (reloadInFlight === reload) reloadInFlight = null;
    };
    reload.then(clear, clear);

    return reload;
};

/** Starts a background reload unless one is running or a recent one just failed. */
const _refreshInBackground = () => {
    if (reloadInFlight || Date.now() < nextBackgroundReloadAt) return;

    _reloadFromIpfs().catch((error) => console.error("Background fetch of domains failed:", error));
};

const getSupportedDomains = (licenses = null) => {
    try {
        // When licenses are provided (from loadOfficialLicenses), use them first so
        // fresh data (e.g. metadata.logo) is not overridden by stale domains cache
        const licenseList = Array.isArray(licenses) ? licenses : licenses && typeof licenses === "object" ? Object.values(licenses) : null;

        if (licenseList && licenseList.length > 0) {
            const existingJson = {};
            for (const [name, domain] of Object.entries(loadCache() || lastKnownDomains || {})) {
                existingJson[name] = asLicenseJson(domain);
            }
            const merged = mergeLicenseMap(existingJson, licenseList);
            const dynamicDomains = {};
            for (const [name, license] of Object.entries(merged)) {
                dynamicDomains[name] = new Domain(license);
            }
            if (Object.keys(dynamicDomains).length > 0) {
                saveCache(dynamicDomains);
                return { ...SUPPORTED_DOMAINS, ...dynamicDomains };
            }
        }

        // Fall back to cache when no licenses provided
        const cachedDomains = loadCache();
        if (cachedDomains) {
            return { ...SUPPORTED_DOMAINS, ...cachedDomains };
        }

        // Expired (or never loaded): refresh in the background and keep answering with the last
        // known licenses meanwhile. Only a process that never loaded any gets the static list.
        _refreshInBackground();
    } catch (error) {
        console.warn("Error loading dynamic domains:", error.message);
    }

    return lastKnownDomains ? { ...SUPPORTED_DOMAINS, ...lastKnownDomains } : SUPPORTED_DOMAINS;
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
    if (config.zelfProof.skipArweave) {
        return false;
    }

    const domainConfig = getDomainConfig(domain);

    if (!domainConfig) return false;

    return Boolean(domainConfig[app]?.storage?.arweaveEnabled);
};

module.exports = {
    LICENSE_CACHE_TTL_SECONDS,
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
    upsertCachedDomain,
    isWalrusStorageSupported,
    isIPFSStorageSupported,
    isArweaveStorageSupported,
};
