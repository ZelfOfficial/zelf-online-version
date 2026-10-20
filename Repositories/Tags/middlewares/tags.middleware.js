const { string, validate, boolean, number, stringEnum, stringOptionalEmptyAsNull } = require("../../../Core/JoiUtils");
const captchaService = require("../../../Core/captcha");
const Session = require("../../Session/models/session.model");
const { validateDomainName, isDomainActive } = require("../modules/domain-registry.module");

const schemas = {
    search: {
        tagName: string(),
        domain: string().required(),
        key: string(),
        value: string(),
        os: stringEnum(["DESKTOP", "ANDROID", "IOS"]),
        captchaToken: stringOptionalEmptyAsNull(),
        duration: stringEnum(["1", "2", "3", "4", "5", "lifetime"]),
        environment: stringEnum(["ipfs", "arweave", "walrus", "all"]),
        type: stringEnum(["both", "mainnet", "hold"]),
    },
    searchByDomain: {
        domain: string().required(),
        storage: stringEnum(["IPFS", "Arweave", "Walrus"]).required(),
        name: string(),
    },
    leaseOffline: {
        tagName: string().required(),
        domain: string().required(),
        zelfProof: string(),
        zelfProofQRCode: string().optional(),
    },
    deleteTag: {
        domain: string().required(),
        tagName: string().required(),
        faceBase64: string().required(),
        password: string(),
    },
    leaseConfirmation: {
        tagName: string().required(),
        domain: string().required(),
        coin: string().required(),
        network: stringEnum(["ETH", "SOL", "BTC"]).required(),
    },
    lease: {
        tagName: string().required(),
        domain: string().required(),
        faceBase64: string().required(),
        type: stringEnum(["create", "import"]).required(),
        os: stringEnum(["DESKTOP", "ANDROID", "IOS"]).required(),
        captchaToken: stringOptionalEmptyAsNull().optional(),
    },
    leaseRecovery: {
        zelfProof: string().required(),
        tagName: string(),
        newTagName: string(),
        domain: string().required(),
        faceBase64: string().required(),
        password: string().allow("", null),
        // Accepted for older clients but ignored: the server derives pin/password from the decrypted password.
        securityType: string().allow("", null).optional(),
        os: stringEnum(["DESKTOP", "ANDROID", "IOS"]).required(),
        captchaToken: stringOptionalEmptyAsNull().optional(),
    },
    decrypt: {
        faceBase64: string().required(),
        password: string(),
        tagName: string().required(),
        domain: string().required(),
        addServerPassword: boolean(),
        os: stringEnum(["DESKTOP", "ANDROID", "IOS"]).required(),
        captchaToken: stringOptionalEmptyAsNull().optional(),
    },
    preview: {
        tagName: string().required(),
        domain: string().required(),
        os: stringEnum(["DESKTOP", "ANDROID", "IOS"]).required(),
        captchaToken: stringOptionalEmptyAsNull().optional(),
    },
    previewZelfProof: {
        zelfProof: string().required(),
        os: stringEnum(["DESKTOP", "ANDROID", "IOS"]).required(),
        captchaToken: stringOptionalEmptyAsNull().optional(),
    },
    previewZelfIdQr: {
        zelfProofQRCode: string().required(),
        os: stringEnum(["DESKTOP", "ANDROID", "IOS"]).required(),
        captchaToken: stringOptionalEmptyAsNull().optional(),
    },
    revenueCatWebhook: {
        event: {
            product_id: string().required(),
            period_type: string().required(),
            currency: string().required(),
            price: number().required(),
            id: string().required(),
            app_id: string().required(),
            transaction_id: string().required(),
            environment: string().required(),
        },
    },
    referralRewards: {},
    purchaseRewards: {},
    update: {
        duration: stringEnum(["1", "2", "3", "4", "5", "lifetime"]).required(),
    },
    walletBalances: {
        ethAddress: string().max(128).allow(""),
        btcAddress: string().max(128).allow(""),
        solanaAddress: string().max(128).allow(""),
        tonAddress: string().max(128).allow(""),
        aptosAddress: string().max(128).allow(""),
    },
};

/**
 * Registry TLDs are stored without a leading dot (`zelf`, not `.zelf`).
 * @param {string} d - domain from query/body
 * @returns {string}
 */
const stripLeadingDot = (d) => {
    if (!d) return d;
    return String(d).replace(/^\./, "");
};

/**
 * Map client/domain typos like "zelfpay" → "zelf" when the pay-suffix is not a real registry TLD.
 * @param {string} d - lowercase domain from query/body
 * @returns {string} - registry TLD for validation and config lookup
 */
const normalizeRegistryDomain = (d) => {
    if (!d) return d;
    const lower = stripLeadingDot(String(d).toLowerCase());
    if (isDomainActive(lower)) return lower;
    if (lower.endsWith("pay") && lower.length > 3) {
        const base = lower.slice(0, -3);
        if (isDomainActive(base)) return base;
    }
    return lower;
};

/**
 * Extract domain from tag name or use provided domain parameter
 * Registry TLD is e.g. zelf / bdag; pin names may use .zelfpay / .bdagpay (not separate domains).
 * @param {string} tagName - Full tag name (e.g., "username.avax", "user.zelfpay")
 * @param {string} domain - Domain parameter from request
 * @returns {Object} - { domain, name } — domain is always the licensed/registry TLD for validation
 */
const extractDomainAndName = (tagName, domain) => {
    if (!tagName) return { domain: null, name: null };

    if (domain) {
        const registryDomain = normalizeRegistryDomain(String(domain).toLowerCase());
        const t = String(tagName);
        const tLower = t.toLowerCase();
        const paySuffix = `.${registryDomain}pay`;
        if (tLower.endsWith(paySuffix)) {
            return { domain: registryDomain, name: t.slice(0, t.length - paySuffix.length) };
        }
        const plainSuffix = `.${registryDomain}`;
        if (tLower.endsWith(plainSuffix)) {
            return { domain: registryDomain, name: t.slice(0, t.length - plainSuffix.length) };
        }
        return { domain: registryDomain, name: t };
    }

    const parts = tagName.split(".");
    if (parts.length >= 2) {
        const last = parts[parts.length - 1].toLowerCase();
        const name = parts.slice(0, -1).join(".");

        if (isDomainActive(last)) {
            return { domain: last, name };
        }

        if (last.endsWith("pay") && last.length > 3) {
            const baseDomain = last.slice(0, -3);
            if (isDomainActive(baseDomain)) {
                return { domain: baseDomain, name };
            }
        }

        return { domain: last, name };
    }

    return { domain: "zelf", name: tagName };
};

/**
 * Validate domain and tag name
 * @param {string} domain - Domain name
 * @param {string} name - Tag name without domain
 * @returns {Object} - Validation result
 */
const validateDomainAndName = async (domain, name) => {
    if (!domain) return { valid: false, error: "Domain is required" };

    const registryDomain = stripLeadingDot(String(domain).toLowerCase());

    let isActive = isDomainActive(registryDomain);

    // Search validation reads an in-memory license cache that can be empty on a
    // fresh worker or after TTL expiry. Load official licenses before 409ing.
    if (!isActive) {
        try {
            const { loadOfficialLicenses } = require("../../License/modules/license.module");
            const { getSupportedDomains } = require("../config/supported-domains");
            const licenses = await loadOfficialLicenses();
            getSupportedDomains(licenses);
            isActive = isDomainActive(registryDomain);
        } catch (error) {
            console.error("Failed to refresh official licenses for domain validation:", error);
        }
    }

    if (!isActive) return { valid: false, error: `Domain '${registryDomain}' is not supported or inactive` };

    if (name) {
        const nameValidation = await validateDomainName(registryDomain, name);

        if (!nameValidation.valid) {
            return nameValidation;
        }
    }

    return { valid: true };
};

/**
 * Get Validation - Multi-domain support
 * @param {*} ctx - Koa context
 * @param {*} next - Next middleware
 */
const getValidation = async (ctx, next) => {
    const { tagName, domain, key, value, captchaToken, os, environment, type } = ctx.request.query;

    const valid = validate(schemas.search, {
        tagName,
        domain,
        key,
        value,
        captchaToken,
        os,
        environment,
        type,
    });

    if (valid.error) {
        ctx.status = 409;

        ctx.body = { validationError: valid.error.message };

        return;
    }

    // Validate domain and tag name if provided
    if (tagName) {
        const { domain: extractedDomain, name } = extractDomainAndName(tagName, domain);
        const domainValidation = await validateDomainAndName(extractedDomain, name);

        if (!domainValidation.valid) {
            ctx.status = 409;
            ctx.body = { validationError: domainValidation.error };
            return;
        }

        // Add extracted domain and name to context for use in controllers
        ctx.state.extractedDomain = extractedDomain;
        ctx.state.extractedName = name;
    }

    if (!tagName && !key && !value) {
        ctx.status = 409;
        ctx.body = { validationError: "missing tagName or key or value" };
        return;
    }

    // Captcha validation
    if (captchaToken) {
        const captchaResult = await captchaService.verifyCaptcha(captchaToken);

        if (!captchaResult.success) {
            ctx.status = 409;
            ctx.body = {
                captchaScore: captchaResult.score,
                validationError: "Captcha not acceptable",
            };
            return;
        }
    }

    await next();
};

const searchByDomainValidation = async (ctx, next) => {
    const { domain, storage, name } = ctx.request.query;

    const valid = validate(schemas.searchByDomain, {
        domain,
        storage,
        name,
    });

    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    await next();
};

/**
 * Lease Validation - Multi-domain support
 * @param {*} ctx - Koa context
 * @param {*} next - Next middleware
 */
const leaseValidation = async (ctx, next) => {
    const { tagName, domain, faceBase64, type, os, captchaToken } = ctx.request.body;

    const valid = validate(schemas.lease, {
        tagName,
        domain,
        faceBase64,
        type,
        os,
        captchaToken,
    });

    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    // Validate domain and tag name
    const { domain: extractedDomain, name } = extractDomainAndName(tagName, domain);
    const domainValidation = await validateDomainAndName(extractedDomain, name);

    if (!domainValidation.valid) {
        ctx.status = 409;
        ctx.body = { validationError: domainValidation.error };
        return;
    }

    // Add extracted domain and name to context
    ctx.state.extractedDomain = extractedDomain;
    ctx.state.extractedName = name;

    // Captcha validation
    if (captchaToken) {
        const captchaResult = await captchaService.verifyCaptcha(captchaToken);

        if (!captchaResult.success) {
            ctx.status = 409;
            ctx.body = {
                captchaScore: captchaResult.score,
                validationError: "Captcha not acceptable",
            };
            return;
        }
    }

    await next();
};

/**
 * Lease Recovery Validation - Multi-domain support
 * @param {*} ctx - Koa context
 * @param {*} next - Next middleware
 */
const leaseRecoveryValidation = async (ctx, next) => {
    const body = ctx.request.body || {};
    if (!body.tagName && body.newTagName) {
        body.tagName = body.newTagName;
    }

    const { zelfProof, tagName, domain, faceBase64, password, securityType, os, captchaToken, newTagName } = body;

    const valid = validate(schemas.leaseRecovery, {
        zelfProof,
        tagName,
        newTagName,
        domain,
        faceBase64,
        password,
        securityType,
        os,
        captchaToken,
    });

    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    // Validate domain and tag name
    const { domain: extractedDomain, name } = extractDomainAndName(tagName, domain);
    const domainValidation = await validateDomainAndName(extractedDomain, name);

    if (!domainValidation.valid) {
        ctx.status = 409;
        ctx.body = { validationError: domainValidation.error };
        return;
    }

    // Add extracted domain and name to context
    ctx.state.extractedDomain = extractedDomain;
    ctx.state.extractedName = name;

    // Captcha validation
    if (captchaToken) {
        const captchaResult = await captchaService.verifyCaptcha(captchaToken);

        if (!captchaResult.success) {
            ctx.status = 409;
            ctx.body = {
                captchaScore: captchaResult.score,
                validationError: "Captcha not acceptable",
            };
            return;
        }
    }

    await next();
};

/**
 * Lease Offline Validation - Multi-domain support
 * @param {*} ctx - Koa context
 * @param {*} next - Next middleware
 */
const leaseOfflineValidation = async (ctx, next) => {
    const { tagName, domain, zelfProof, zelfProofQRCode } = ctx.request.body;

    const valid = validate(schemas.leaseOffline, {
        tagName,
        domain,
        zelfProof,
        zelfProofQRCode,
    });

    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    // Validate domain and tag name
    const { domain: extractedDomain, name } = extractDomainAndName(tagName, domain);

    const domainValidation = await validateDomainAndName(extractedDomain, name);

    if (!domainValidation.valid) {
        ctx.status = 409;
        ctx.body = { validationError: domainValidation.error };
        return;
    }

    // Add extracted domain and name to context
    ctx.state.extractedDomain = extractedDomain;

    ctx.state.extractedName = name;

    await next();
};

/**
 * Delete Tag Validation
 * @param {*} ctx - Koa context
 * @param {*} next - Next middleware
 */
const deleteTagValidation = async (ctx, next) => {
    const { cid, tagName, domain, faceBase64, password } = ctx.request.body || {};

    const valid = validate(schemas.deleteTag, {
        cid,
        tagName,
        domain,
        faceBase64,
        password,
    });

    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    await next();
};

/**
 * Lease Confirmation Validation - Multi-domain support
 * @param {*} ctx - Koa context
 * @param {*} next - Next middleware
 */
const leaseConfirmationValidation = async (ctx, next) => {
    const payload = Object.assign(ctx.request.query, ctx.request.body);

    const { tagName, domain, coin, network } = payload;

    const valid = validate(schemas.leaseConfirmation, {
        tagName,
        domain,
        coin,
        network,
    });

    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    // Validate domain and tag name
    const { domain: extractedDomain, name } = extractDomainAndName(tagName, domain);
    const domainValidation = await validateDomainAndName(extractedDomain, name);

    if (!domainValidation.valid) {
        ctx.status = 409;
        ctx.body = { validationError: domainValidation.error };
        return;
    }

    // Add extracted domain and name to context
    ctx.state.extractedDomain = extractedDomain;
    ctx.state.extractedName = name;

    await next();
};

/**
 * Preview Validation - Multi-domain support
 * @param {*} ctx - Koa context
 * @param {*} next - Next middleware
 */
const previewValidation = async (ctx, next) => {
    const payload = Object.assign(ctx.request.query, ctx.request.body);

    const { tagName, domain, os, captchaToken } = payload;

    const valid = validate(schemas.preview, {
        tagName,
        domain,
        os,
        captchaToken,
    });

    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    // Validate domain and tag name
    const { domain: extractedDomain, name } = extractDomainAndName(tagName, domain);
    const domainValidation = await validateDomainAndName(extractedDomain, name);

    if (!domainValidation.valid) {
        ctx.status = 409;
        ctx.body = { validationError: domainValidation.error };
        return;
    }

    // Add extracted domain and name to context
    ctx.state.extractedDomain = extractedDomain;
    ctx.state.extractedName = name;

    // Captcha validation
    if (captchaToken) {
        const captchaResult = await captchaService.createAssessment(captchaToken, os, "preview");

        if (!captchaResult.success) {
            ctx.status = 409;
            ctx.body = {
                captchaScore: captchaResult.score,
                validationError: "Captcha not acceptable",
            };
            return;
        }
    }

    await next();
};

/**
 * Preview ZelfProof Validation
 * @param {*} ctx - Koa context
 * @param {*} next - Next middleware
 */
const previewZelfProofValidation = async (ctx, next) => {
    const { zelfProof, os, captchaToken } = ctx.request.body;

    const valid = validate(schemas.previewZelfProof, {
        zelfProof,
        os,
        captchaToken,
    });

    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    // Captcha validation
    if (captchaToken) {
        const captchaResult = await captchaService.verifyCaptcha(captchaToken);

        if (!captchaResult.success) {
            ctx.status = 409;
            ctx.body = {
                captchaScore: captchaResult.score,
                validationError: "Captcha not acceptable",
            };
            return;
        }
    }

    await next();
};

/**
 * Preview ZelfId QR Validation
 * @param {*} ctx - Koa context
 * @param {*} next - Next middleware
 */
const previewZelfIdQrValidation = async (ctx, next) => {
    const { zelfProofQRCode, os, captchaToken } = ctx.request.body;

    const valid = validate(schemas.previewZelfIdQr, {
        zelfProofQRCode,
        os,
        captchaToken,
    });

    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    // Captcha validation
    if (captchaToken) {
        const captchaResult = await captchaService.verifyCaptcha(captchaToken);

        if (!captchaResult.success) {
            ctx.status = 409;
            ctx.body = {
                captchaScore: captchaResult.score,
                validationError: "Captcha not acceptable",
            };
            return;
        }
    }

    await next();
};

/**
 * Decrypt Validation - Multi-domain support
 * @param {*} ctx - Koa context
 * @param {*} next - Next middleware
 */
const decryptValidation = async (ctx, next) => {
    const { faceBase64, password, tagName, domain, addServerPassword, os, captchaToken } = ctx.request.body;

    const valid = validate(schemas.decrypt, {
        faceBase64,
        password,
        tagName,
        domain,
        addServerPassword,
        os,
        captchaToken,
    });

    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    // Validate domain and tag name
    const { domain: extractedDomain, name } = extractDomainAndName(tagName, domain);
    const domainValidation = await validateDomainAndName(extractedDomain, name);

    if (!domainValidation.valid) {
        ctx.status = 409;
        ctx.body = { validationError: domainValidation.error };
        return;
    }

    // Add extracted domain and name to context
    ctx.state.extractedDomain = extractedDomain;
    ctx.state.extractedName = name;

    // Captcha validation
    if (captchaToken) {
        const captchaResult = await captchaService.verifyCaptcha(captchaToken);

        if (!captchaResult.success) {
            ctx.status = 409;
            ctx.body = {
                captchaScore: captchaResult.score,
                validationError: "Captcha not acceptable",
            };
            return;
        }
    }

    await next();
};

/**
 * RevenueCat Webhook Validation
 * @param {*} ctx - Koa context
 * @param {*} next - Next middleware
 */
const revenueCatWebhookValidation = async (ctx, next) => {
    const payload = Object.assign(ctx.request.query, ctx.request.body);

    const { event } = payload;

    const valid = validate(schemas.revenueCatWebhook, {
        event,
    });

    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    if (!event) {
        ctx.status = 409;
        ctx.body = { validationError: "Missing event payload" };
        return;
    }

    await next();
};

/**
 * Referral Rewards Validation
 * @param {*} ctx - Koa context
 * @param {*} next - Next middleware
 */
const referralRewardsValidation = async (ctx, next) => {
    const payload = Object.assign(ctx.request.query, ctx.request.body);

    const valid = validate(schemas.referralRewards, payload);

    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    // Check if user is super admin
    const authUser = ctx.state.user;
    if (!authUser.superAdminId) {
        ctx.status = 403;
        ctx.body = { error: "Unauthorized" };
        return;
    }

    await next();
};

/**
 * Purchase Rewards Validation
 * @param {*} ctx - Koa context
 * @param {*} next - Next middleware
 */
const purchaseRewardsValidation = async (ctx, next) => {
    const payload = Object.assign(ctx.request.query, ctx.request.body);

    const valid = validate(schemas.purchaseRewards, payload);

    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    // Check if user is super admin
    const authUser = ctx.state.user;
    if (!authUser.superAdminId) {
        ctx.status = 403;
        ctx.body = { error: "Unauthorized" };
        return;
    }

    await next();
};

/**
 * Update Validation - Multi-domain support
 * @param {*} ctx - Koa context
 * @param {*} next - Next middleware
 */
const updateValidation = async (ctx, next) => {
    const payload = Object.assign(ctx.request.query, ctx.request.body);

    const { duration } = payload;

    const valid = validate(schemas.update, {
        duration,
    });

    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    // Extract domain from tag name in URL params
    const tagName = ctx.params.tagName;
    if (tagName) {
        const { domain: extractedDomain, name } = extractDomainAndName(tagName);
        const domainValidation = await validateDomainAndName(extractedDomain, name);

        if (!domainValidation.valid) {
            ctx.status = 409;
            ctx.body = { validationError: domainValidation.error };
            return;
        }

        // Add extracted domain and name to context
        ctx.state.extractedDomain = extractedDomain;
        ctx.state.extractedName = name;
    }

    await next();
};

/**
 * GET /tags/wallet-balances — optional eth/btc/solana/ton/aptos query params; at least one non-empty required.
 */
const walletBalancesValidation = async (ctx, next) => {
    const q = ctx.request.query || {};
    const ethAddress = typeof q.ethAddress === "string" ? q.ethAddress.trim() : "";
    const btcAddress = typeof q.btcAddress === "string" ? q.btcAddress.trim() : "";
    const solanaAddress = typeof q.solanaAddress === "string" ? q.solanaAddress.trim() : "";
    const tonAddress = typeof q.tonAddress === "string" ? q.tonAddress.trim() : "";
    const aptosAddress = typeof q.aptosAddress === "string" ? q.aptosAddress.trim() : "";

    if (!ethAddress && !btcAddress && !solanaAddress && !tonAddress && !aptosAddress) {
        ctx.status = 409;
        ctx.body = { validationError: "missing at least one of ethAddress, btcAddress, solanaAddress, tonAddress, aptosAddress\n" };
        return;
    }

    const valid = validate(schemas.walletBalances, {
        ethAddress: ethAddress || undefined,
        btcAddress: btcAddress || undefined,
        solanaAddress: solanaAddress || undefined,
        tonAddress: tonAddress || undefined,
        aptosAddress: aptosAddress || undefined,
    });

    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    ctx.state.walletBalanceQuery = {
        ethAddress: ethAddress || undefined,
        btcAddress: btcAddress || undefined,
        solanaAddress: solanaAddress || undefined,
        tonAddress: tonAddress || undefined,
        aptosAddress: aptosAddress || undefined,
    };

    await next();
};

module.exports = {
    getValidation,
    searchByDomainValidation,
    leaseValidation,
    leaseRecoveryValidation,
    leaseOfflineValidation,
    deleteTagValidation,
    leaseConfirmationValidation,
    previewValidation,
    previewZelfProofValidation,
    previewZelfIdQrValidation,
    decryptValidation,
    revenueCatWebhookValidation,
    referralRewardsValidation,
    purchaseRewardsValidation,
    updateValidation,
    walletBalancesValidation,
    // Utility functions
    extractDomainAndName,
    validateDomainAndName,
};
