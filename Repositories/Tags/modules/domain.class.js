const config = require("../../../Core/config");
/**
 * Domain Class
 *
 * This class represents a single domain configuration with all its properties
 * and methods. It's designed to work with external data sources like databases
 * or APIs where domain configurations come as JSON objects.
 */
class Domain {
    constructor(domainData) {
        // Generate random name if none provided
        this.name = domainData.name || this._generateRandomName();

        // Set owner from authUser if provided
        this.owner = domainData.owner || (domainData.authUser ? domainData.authUser.email : "");

        // Core properties
        this.type = domainData.type || "custom";
        this.holdSuffix = domainData.holdSuffix || ".hold";
        this.status = domainData.status || "inactive";
        this.description = domainData.description || "";
        this.startDate = domainData.startDate || "";
        this.endDate = domainData.endDate || "";
        this.features = domainData.features || [];
        // Validation rules
        this.tags = {
            minLength: domainData.tags?.minLength || 3,
            maxLength: domainData.tags?.maxLength || 50,
            allowedChars: domainData.tags?.allowedChars || /^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$/,
            reserved: domainData.tags?.reserved || [],
            customRules: domainData.tags?.customRules || [],
            payment: {
                methods: domainData.tags?.payment?.methods || ["crypto", "stripe"],
                currencies: domainData.tags?.payment?.currencies || ["USD"],
                networks: domainData.tags?.payment?.networks || {},
                discounts: domainData.tags?.payment.discounts || {
                    yearly: 0.1,
                    lifetime: 0.2,
                },
                rewardPrice: domainData.tags?.payment?.rewardPrice || 10,
                whitelist: domainData.tags?.payment.whitelist || {},
                pricingTable: domainData.tags?.payment.pricingTable || {},
                planPricing: domainData.tags?.payment?.planPricing || {},
            },
            storage: {
                keyPrefix: domainData.tags?.storage?.keyPrefix || "tagName",
                ipfsEnabled: domainData.tags?.storage?.ipfsEnabled ?? true,
                arweaveEnabled: domainData.tags?.storage?.arweaveEnabled ?? true,
                walrusEnabled: domainData.tags?.storage?.walrusEnabled ?? false,
                backupEnabled: domainData.tags?.storage?.backupEnabled ?? false,
            },
            wallet: {
                networks: domainData.tags?.wallet?.networks || domainData.wallet?.networks || {},
            },
        };

        this.zelfkeys = {
            plans: domainData.zelfkeys?.plans || [],
            payment: {
                whitelist: domainData.zelfkeys?.payment?.whitelist || domainData.zelfkeys?.whitelist || {},
                pricingTable: domainData.zelfkeys?.payment?.pricingTable || domainData.zelfkeys?.pricingTable || {},
            },
            storage: {
                keyPrefix: domainData.zelfkeys?.storage?.keyPrefix || "tagName",
                ipfsEnabled: domainData.zelfkeys?.storage?.ipfsEnabled ?? true,
                arweaveEnabled: domainData.zelfkeys?.storage?.arweaveEnabled ?? true,
                walrusEnabled: domainData.zelfkeys?.storage?.walrusEnabled ?? false,
                backupEnabled: domainData.zelfkeys?.storage?.backupEnabled ?? false,
            },
        };

        this.stripe = {
            productId: domainData.stripe?.productId || "",
            priceId: domainData.stripe?.priceId || "",
            latestInvoiceId: domainData.stripe?.latestInvoiceId || "",
            amountPaid: domainData.stripe?.amountPaid || 0,
            paidAt: domainData.stripe?.paidAt || "",
        };

        // Limits - support both old and new structure > this will be modified from the subscription plan (stripe)
        this.limits = {
            tags: domainData.limits?.tags || 100,
            zelfkeys: domainData.limits?.zelfkeys || 100,
            zelfProofs: domainData.limits?.zelfProofs || 100,
        };

        // Metadata
        this.metadata = domainData.metadata || {};

        // Theme Settings - preserve complete themeSettings from license data
        this.themeSettings = domainData.themeSettings || {};

        /** Optional second document URL (official license JSON on IPFS); not exposed in toJSON */
        this.themeSettingsUrl = typeof domainData.themeSettingsUrl === "string" ? domainData.themeSettingsUrl : "";
        this.updatedAt = domainData.updatedAt || domainData.metadata?.updatedAt || "";
        this.ipfsCid = domainData.ipfsCid || "";
    }

    /**
     * Check if domain is active
     * @returns {boolean} - True if domain is active
     */
    isActive() {
        return this.status === "active";
    }

    /**
     * Check if domain supports a feature
     * @param {string} feature - Feature name
     * @returns {boolean} - True if feature is supported
     */
    supportsFeature(feature) {
        return this.features.includes(feature);
    }

    /**
     * License table for a Zelf ID plan, or the Tags default table.
     * @param {"premium"|"unlimited"|string} [plan]
     * @returns {Object}
     */
    _pricingTableForPlan(plan) {
        const fallback = this.tags?.payment?.pricingTable || {};
        if (plan !== "premium" && plan !== "unlimited") return fallback;

        const planTable = this.tags?.payment?.planPricing?.[plan];
        if (planTable && typeof planTable === "object" && Object.keys(planTable).length > 0) {
            return planTable;
        }

        if (String(this.name || "").toLowerCase() === "zelf") {
            const { defaultZelfIdPlanPricingTables } = require("../../ZelfID/modules/zelf-ids-revenue-cat-products.module");
            const defaults = defaultZelfIdPlanPricingTables()[plan];
            if (defaults && Object.keys(defaults).length > 0) {
                return defaults;
            }
        }

        return fallback;
    }

    /**
     * @param {Object} table
     * @param {number} length
     * @param {string} duration
     * @returns {number|undefined}
     */
    _lookupTablePrice(table, length, duration) {
        if (length >= 6 && length <= 15) return table?.["6-15"]?.[duration];
        return table?.[length]?.[duration];
    }

    /**
     * Get domain price for specific tag length and duration
     * @param {string} tagName - Tag name
     * @param {string} duration - Duration ('1', '2', '3', '4', '5', 'lifetime')
     * @param {string} [referralTagName]
     * @param {{ plan?: "premium"|"unlimited" }} [options] - Zelf ID plan table; Tags ignore this
     * @returns {Object} - Quote in USD
     */
    getPrice(tagName, duration = "1", referralTagName = "", options = {}) {
        if (!tagName) {
            return {
                duration,
                price: 0,
                currency: "USD",
                reward: 0,
                discount: 0,
                priceWithoutDiscount: 0,
                discountType: "percentage",
                length: 0,
            };
        }

        const splitTagName = tagName.split(".");

        // Ensure referralTagName is a string before calling replace
        referralTagName = (referralTagName || "").replace(".hold", "");

        const length = splitTagName[0].length;
        const plan = options && typeof options === "object" ? options.plan : undefined;
        const fallbackTable = this.tags?.payment?.pricingTable || {};
        const table = this._pricingTableForPlan(plan);

        if (!fallbackTable && !table) return 0;

        if (!["1", "2", "3", "4", "5", "lifetime"].includes(`${duration}`))
            throw new Error("Invalid duration. Use '1', '2', '3', '4', '5' or 'lifetime'.");

        let price = this._lookupTablePrice(table, length, duration);
        if (price == null && table !== fallbackTable) {
            price = this._lookupTablePrice(fallbackTable, length, duration);
        }

        if (price == null) {
            if (length < 1 || length > 27) {
                throw new Error("Invalid name length. Length must be between 1 and 27.");
            }
            price = 24;
        }

        // Adjust price for development environment
        price = config.token.priceEnv === "development" ? price / 30 : price;

        const priceWithoutDiscount = Number(price);

        let discount = 0;

        let discountType = "percentage";

        const whitelist = this.tags?.payment.whitelist || {};

        if (Object.keys(whitelist).length && referralTagName && whitelist[referralTagName]) {
            const amount = whitelist[referralTagName];

            if (amount.includes("%")) {
                discountType = "percentage";
                discount = parseInt(amount);

                price = price - price * (discount / 100);
            } else {
                discount = parseInt(amount);
                discountType = "amount";
                price = price - discount;
            }
        } else if (referralTagName) {
            // default discount 10 %
            price = price - price * 0.1;
        }

        // Round to 2 decimal places (nearest cent)
        return {
            duration,
            price: Math.max(Math.round(price * 100) / 100, 0),
            currency: "USD",
            reward: Math.max(Math.round((price / this.tags?.payment.rewardPrice) * 100) / 100, 0),
            discount,
            priceWithoutDiscount,
            discountType,
            length,
        };
    }

    /**
     * Validate tag name against domain rules
     * @param {string} tagName - Tag name to validate
     * @returns {Object} - Validation result
     */
    validateTagName(tagName) {
        // Check minimum length
        if (tagName.length < this.tags?.minLength) {
            return {
                valid: false,
                error: `Tag name must be at least ${this.validation.minLength} characters long`,
            };
        }

        // Check maximum length
        if (tagName.length > this.tags?.maxLength) {
            return {
                valid: false,
                error: `Tag name must be no more than ${this.tags?.maxLength} characters long`,
            };
        }

        // Check allowed characters
        if (!this.validation.allowedChars.test(tagName)) {
            return {
                valid: false,
                error: `Tag name contains invalid characters. Allowed pattern: ${this.validation.allowedChars}`,
            };
        }

        // Check reserved names
        if (this.validation.reserved.includes(tagName.toLowerCase())) {
            return {
                valid: false,
                error: `Tag name '${tagName}' is reserved`,
            };
        }

        // Check custom rules
        for (const rule of this.validation.customRules) {
            if (typeof rule === "function") {
                const result = rule(tagName);
                if (!result.valid) {
                    return result;
                }
            }
        }

        return { valid: true };
    }

    /**
     * Generate storage key for tag
     * @param {string} tagName - Tag name
     * @returns {string} - Storage key
     */
    generateStorageKey(tagName) {
        return `${this.storage.keyPrefix}_${tagName}`;
    }

    /**
     * Generate hold domain name
     * @param {string} tagName - Tag name
     * @returns {string} - Hold domain name
     */
    generateHoldDomain(tagName) {
        return `${tagName}${this.holdSuffix}.${this.name}`;
    }

    /**
     * Check if IPFS is enabled
     * @returns {boolean} - True if IPFS is enabled
     */
    isIPFSEnabled() {
        return this.tags.storage.ipfsEnabled;
    }

    /**
     * Check if Arweave is enabled.
     * Honors SKIP_ARWEAVE for local/dev QA and ops cost control (same gate as legacy ZNS v2).
     * @returns {boolean} - True if Arweave is enabled
     */
    isArweaveEnabled() {
        if (config.zelfProof.skipArweave) {
            return false;
        }
        return this.tags.storage.arweaveEnabled;
    }

    isWalrusEnabled() {
        return this.tags.storage.walrusEnabled;
    }

    /**
     * Check if backup is enabled
     * @returns {boolean} - True if backup is enabled
     */
    isBackupEnabled() {
        return this.tags.storage.backupEnabled;
    }

    /**
     * Get domain statistics
     * @returns {Object} - Domain statistics
     */
    getStats() {
        return {
            name: this.name,
            type: this.type,
            status: this.status,
            owner: this.owner,
            price: this.price,
            features: this.features,
            limits: this.limits,
            metadata: this.metadata,
        };
    }

    /**
     * Convert domain to JSON object
     * @returns {Object} - Domain as JSON
     */
    toJSON() {
        return {
            name: this.name,
            type: this.type,
            holdSuffix: this.holdSuffix,
            status: this.status,
            owner: this.owner,
            description: this.description,
            startDate: this.startDate,
            endDate: this.endDate,
            features: this.features || [],
            tags: this.tags,
            zelfkeys: this.zelfkeys,
            storage: this.tags.storage,
            stripe: this.stripe,
            limits: this.limits,
            metadata: this.metadata,
            themeSettings: this.themeSettings, // Include complete themeSettings in JSON output
            updatedAt: this.updatedAt || "",
            ipfsCid: this.ipfsCid || "",
        };
    }

    /**
     * Create domain from JSON object
     * @param {Object} jsonData - JSON data
     * @returns {Domain} - Domain instance
     */
    static fromJSON(jsonData) {
        return new Domain(jsonData);
    }

    /**
     * Create domain from database record
     * @param {Object} dbRecord - Database record
     * @returns {Domain} - Domain instance
     */
    static fromDatabase(dbRecord) {
        // Handle case where domain config is stored as JSON string
        const domainData = typeof dbRecord.config === "string" ? JSON.parse(dbRecord.config) : dbRecord.config;

        return new Domain({
            name: dbRecord.domainName || dbRecord.name,
            ...domainData,
        });
    }

    /**
     * Create domain from API response
     * @param {Object} apiResponse - API response data
     * @returns {Domain} - Domain instance
     */
    static fromAPI(apiResponse) {
        return new Domain(apiResponse);
    }

    /**
     * Get the tag key for this domain
     * @returns {string} - The tag key (storage.keyPrefix)
     */
    getTagKey() {
        return this.tags.storage.keyPrefix;
    }

    /**
     * Generate a random domain name
     * @returns {string} - Random domain name
     */
    _generateRandomName() {
        return Math.random().toString(36).substring(2, 8);
    }
}

/**
 * Domain Factory Class
 *
 * This class manages multiple domains and provides methods to create
 * domain instances from various external sources (database, API, JSON, etc.)
 */
class DomainFactory {
    constructor() {
        this.domains = new Map();
    }

    /**
     * Create domain from JSON data
     * @param {Object} domainData - Domain data object
     * @returns {Domain} - Domain instance
     */
    createFromJSON(domainData) {
        const domain = Domain.fromJSON(domainData);
        this.domains.set(domain.name, domain);
        return domain;
    }

    /**
     * Create domain from database record
     * @param {Object} dbRecord - Database record
     * @returns {Domain} - Domain instance
     */
    createFromDatabase(dbRecord) {
        const domain = Domain.fromDatabase(dbRecord);
        this.domains.set(domain.name, domain);
        return domain;
    }

    /**
     * Create domain from API response
     * @param {Object} apiResponse - API response data
     * @returns {Domain} - Domain instance
     */
    createFromAPI(apiResponse) {
        const domain = Domain.fromAPI(apiResponse);
        this.domains.set(domain.name, domain);
        return domain;
    }

    /**
     * Create multiple domains from array of data
     * @param {Array} domainsData - Array of domain data objects
     * @returns {Array} - Array of Domain instances
     */
    createMultiple(domainsData) {
        return domainsData.map((data) => this.createFromJSON(data));
    }

    /**
     * Get domain by name
     * @param {string} name - Domain name
     * @returns {Domain|null} - Domain instance or null
     */
    getDomain(name) {
        return this.domains.get(name) || null;
    }

    /**
     * Check if domain exists
     * @param {string} name - Domain name
     * @returns {boolean} - True if domain exists
     */
    hasDomain(name) {
        return this.domains.has(name);
    }

    /**
     * Remove domain
     * @param {string} name - Domain name
     * @returns {boolean} - True if domain was removed
     */
    removeDomain(name) {
        return this.domains.delete(name);
    }

    /**
     * Update domain
     * @param {string} name - Domain name
     * @param {Object} updates - Updates to apply
     * @returns {Domain|null} - Updated domain or null
     */
    updateDomain(name, updates) {
        const domain = this.getDomain(name);
        if (!domain) return null;

        // Update properties
        Object.keys(updates).forEach((key) => {
            if (domain.hasOwnProperty(key)) {
                domain[key] = updates[key];
            }
        });

        return domain;
    }

    /**
     * Get domain count
     * @returns {number} - Total number of domains
     */
    getDomainCount() {
        return this.domains.size;
    }

    /**
     * Import domains from JSON array
     * @param {Array} domainsJSON - Array of domain JSON objects
     * @returns {Array} - Array of created Domain instances
     */
    importFromJSON(domainsJSON) {
        return domainsJSON.map((domainData) => this.createFromJSON(domainData));
    }

    /**
     * Clear all domains
     */
    clear() {
        this.domains.clear();
    }

    /**
     * Reset to default domains
     */
    reset() {
        this.clear();
    }
}

// Create singleton instance (domains will be loaded when needed)
const domainFactory = new DomainFactory();

module.exports = {
    Domain,
    DomainFactory,
    domainFactory,
};
