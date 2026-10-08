const Module = require("../modules/tags.module");
const RewardRoutesController = require("./reward-routes.controller");
const { updateOldTagObject } = require("../modules/my-tags.module");
const TagsRecoveryModule = require("../modules/tags-recovery.module");
const TagsOfflineModule = require("../modules/tags-offline.module");
const TagsSearchModule = require("../modules/tags-search.module");
const { getAllSupportedDomains } = require("../modules/domain-registry.module");
const { errorHandler } = require("../../../Core/http-handler");
const configuration = require("../../../Core/config");
const ZelfProofModule = require("../../ZelfProof/modules/zelf-proof.module");
const { resolveEncryptVersion } = require("../modules/tags-addresses.module");
const { hasMissingOwner, applyPreviewPublicData } = require("../../Tags/modules/tag-preview-public-data");
const TagWalletBalancesModule = require("../modules/tag-wallet-balances.module");

/**
 * Keep full pin name (e.g. user.zelfpay) for IPFS lookup; middleware only supplies registry TLD + local name.
 * @param {string|undefined} rawTagName - tagName from query/body
 * @param {string|null|undefined} extractedName
 * @param {string|null|undefined} extractedDomain - registry domain (zelf, bdag, …)
 */
const resolveFullTagNameForRequest = (rawTagName, extractedName, extractedDomain) => {
    const raw = rawTagName != null && rawTagName !== "" ? String(rawTagName).trim() : "";
    if (raw.includes(".")) {
        return raw.toLowerCase();
    }
    if (extractedName != null && extractedName !== "" && extractedDomain) {
        return `${extractedName}.${extractedDomain}`.toLowerCase();
    }
    return raw.toLowerCase();
};

/**
 * Handle old tag object updates
 * @param {Object} data - Search result data
 * @param {string} domain - Domain name
 * @returns {Object} - Updated data
 */
const handleOldTagUpdate = async (data, domain = "zelf") => {
    if (data && data.ipfs?.length) {
        const tagObject = data.ipfs[0];

        if (!tagObject.publicData.registeredAt) {
            const updatedTagObject = await updateOldTagObject(tagObject, domain);
            data.ipfs[0] = updatedTagObject;
        }
    }

    return data;
};

/**
 * Search for a tag (v2)
 * @param {Object} ctx - Koa context
 * @returns {Object} - Search results
 */
const searchTag = async (ctx) => {
    try {
        const { extractedDomain, extractedName } = ctx.state;

        // Add domain context to request
        const requestData = {
            ...ctx.request.query,
            tagName: resolveFullTagNameForRequest(ctx.request.query.tagName, extractedName, extractedDomain),
            domain: extractedDomain || ctx.request.query.domain,
            environment: ctx.request.query.environment,
            type: ctx.request.query.type || "both",
        };

        let data = await Module.searchTag(requestData, ctx.state.user);

        if (
            data.tagObject?.zelfProof &&
            (hasMissingOwner(data.tagObject.publicData) ||
                ZelfProofModule.shouldBackfillHasPassword(data.tagObject.publicData, resolveEncryptVersion(data.tagObject.publicData)))
        ) {
            try {
                data.preview = await ZelfProofModule.previewWithLegacyFallback({
                    zelfProof: data.tagObject.zelfProof,
                });
                ZelfProofModule.applyPreviewHasPassword(data.tagObject, data.preview);
                applyPreviewPublicData(data.tagObject, data.preview);
            } catch (_error) {
                // Search still succeeds when preview cannot read an old proof.
            }
        }

        ctx.body = { data };
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;

        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

/**
 * Search for a tag (v2)
 * @param {Object} ctx - Koa context
 * @returns {Object} - Search results
 */
const searchTagsByDomain = async (ctx) => {
    try {
        const { domain, storage, limit, pageOffset, name } = ctx.request.query;

        let data = await TagsSearchModule.searchByDomain({ domain, storage, limit, pageOffset, name }, ctx.state.user);

        ctx.body = {
            data,
            limit,
            total: data.length,
        };
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;

        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

/**
 * Lease a tag (v2)
 * @param {Object} ctx - Koa context
 * @returns {Object} - Lease results
 */
const leaseTag = async (ctx) => {
    try {
        const { extractedDomain, extractedName } = ctx.state;

        const requestData = {
            ...ctx.request.body,
            tagName: resolveFullTagNameForRequest(ctx.request.body.tagName, extractedName, extractedDomain),
            domain: extractedDomain,
        };

        const data = await Module.leaseTag(requestData, ctx.state.user);

        ctx.body = { data };
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;

        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

/**
 * Lease recovery for tags
 * @param {Object} ctx - Koa context
 * @returns {Object} - Recovery results
 */
const leaseRecovery = async (ctx) => {
    try {
        const { extractedDomain, extractedName } = ctx.state;

        const requestData = {
            ...ctx.request.body,
            tagName: resolveFullTagNameForRequest(ctx.request.body.tagName, extractedName, extractedDomain),
            domain: extractedDomain,
        };

        const data = await TagsRecoveryModule.leaseRecovery(requestData, ctx.state.user);

        ctx.body = { data };
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;

        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

/**
 * Lease tag offline (v2)
 * @param {Object} ctx - Koa context
 * @returns {Object} - Offline lease results
 */
const leaseOfflineTag = async (ctx) => {
    try {
        const { extractedDomain, extractedName } = ctx.state;

        const requestData = {
            ...ctx.request.body,
            tagName: resolveFullTagNameForRequest(ctx.request.body.tagName, extractedName, extractedDomain),
            domain: extractedDomain,
        };

        const data = await TagsOfflineModule.leaseOfflineTag(requestData, ctx.state.user);

        ctx.body = { data };
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;

        ctx.body = { message: _exception.message, code: _exception.code };
        if (error.rejected) {
            ctx.body.rejected = error.rejected;
        }
    }
};

/**
 * Lease confirmation for tags (v2)
 * @param {Object} ctx - Koa context
 * @returns {Object} - Confirmation results
 */
const leaseConfirmation = async (ctx) => {
    try {
        const { extractedDomain, extractedName } = ctx.state;

        const requestData = {
            ...ctx.request.body,
            tagName: resolveFullTagNameForRequest(ctx.request.body.tagName, extractedName, extractedDomain),
            domain: extractedDomain,
        };

        const data = await Module.leaseConfirmation(requestData, ctx.state.user);

        ctx.body = { data };
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;

        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

/**
 * Preview tag (v2)
 * @param {Object} ctx - Koa context
 * @returns {Object} - Preview results
 */
const previewTag = async (ctx) => {
    try {
        const { extractedDomain, extractedName } = ctx.state;

        const rawTag = ctx.request.query.tagName ?? ctx.request.body.tagName;

        const requestData = {
            ...ctx.request.query,
            ...ctx.request.body,
            tagName: resolveFullTagNameForRequest(rawTag, extractedName, extractedDomain),
            domain: extractedDomain,
        };

        const data = await Module.previewTag(requestData, ctx.state.user);

        ctx.body = { data };
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;

        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

/**
 * Preview ZelfProof
 * @param {Object} ctx - Koa context
 * @returns {Object} - Preview results
 */
const previewZelfProof = async (ctx) => {
    try {
        const data = await Module.previewZelfProof(ctx.request.body, ctx.state.user);

        ctx.body = { data };
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;

        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

/**
 * Preview ZelfId QR
 * @param {Object} ctx - Koa context
 * @returns {Object} - Preview results
 */
const previewZelfIdQr = async (ctx) => {
    try {
        const data = await Module.previewZelfIdQr(ctx.request.body, ctx.state.user);

        ctx.body = { data };
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;

        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

/**
 * Decrypt tag (v2)
 * @param {Object} ctx - Koa context
 * @returns {Object} - Decrypt results
 */
const decryptTag = async (ctx) => {
    try {
        const { extractedDomain, extractedName } = ctx.state;

        const requestData = {
            ...ctx.request.body,
            tagName: resolveFullTagNameForRequest(ctx.request.body.tagName, extractedName, extractedDomain),
            domain: extractedDomain,
        };

        const data = await Module.decryptTag(requestData, ctx.state.user);

        ctx.body = { data };
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;

        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

/**
 * RevenueCat webhook: retired on /api/tags (410), Zelf IDs use POST /api/zelf-ids/revenue-cat.
 * Purchase rewards: releases the oldest pending Tags purchase reward.
 * Referral rewards: retired (410), paid per referral by POST /api/my-tags/referrals/claim.
 * See reward-routes.controller.js.
 */
const revenueCatWebhook = RewardRoutesController.tagsRevenueCatRetired;

const purchaseRewards = RewardRoutesController.purchaseRewards;

const referralRewards = RewardRoutesController.referralRewardsRetired;

/**
 * Delete tag from IPFS
 * @param {Object} ctx - Koa context
 * @returns {Object} - Delete result
 */
const deleteTag = async (ctx) => {
    try {
        const { cid, faceBase64, password, tagName, domain } = ctx.request.body;

        const result = await Module.deleteTag({ cid, faceBase64, password, tagName, domain }, ctx.state.user);

        ctx.body = { data: result };
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;

        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

const getDomains = async (ctx, next) => {
    try {
        const {
            loadOfficialLicenses,
            parseIncludeThemeSettings,
            fetchAndMergeOfficialThemeSettings,
        } = require("../../License/modules/license.module");

        const rawLicenses = await loadOfficialLicenses();
        const includeTheme = parseIncludeThemeSettings(ctx.request.query.includeThemeSettings);

        let licenses = rawLicenses;
        if (includeTheme) {
            const list = Array.isArray(rawLicenses) ? rawLicenses : Object.values(rawLicenses || {});
            licenses = (
                await Promise.all(
                    list.map(async (lic) => {
                        if (!lic || !lic.name) return null;
                        const copy = JSON.parse(JSON.stringify(lic));
                        await fetchAndMergeOfficialThemeSettings(copy);
                        return copy;
                    }),
                )
            ).filter(Boolean);
        }

        const { includeNonPaid } = ctx.request.query;

        const domains = getAllSupportedDomains(
            licenses,
            includeNonPaid !== undefined ? !Boolean(includeNonPaid === "true") : configuration.env === "development" ? false : true,
        );

        ctx.body = { data: domains };
    } catch (error) {
        console.error("Error loading domains:", error);
        const domains = getAllSupportedDomains();
        ctx.body = { data: domains };
    }

    await next();
};

const getDomain = async (ctx, next) => {
    const { domain } = ctx.request.params;
    const {
        loadOfficialLicenses,
        parseIncludeThemeSettings,
        fetchAndMergeOfficialThemeSettings,
    } = require("../../License/modules/license.module");
    const { Domain } = require("../modules/domain.class");

    const includeTheme = parseIncludeThemeSettings(ctx.request.query.includeThemeSettings);

    let domainConfig = null;

    if (includeTheme) {
        try {
            const raw = await loadOfficialLicenses();
            const list = Array.isArray(raw) ? raw : Object.values(raw || {});
            const lic = list.find((l) => l && l.name && String(l.name).toLowerCase() === domain.toLowerCase());
            if (lic) {
                const copy = JSON.parse(JSON.stringify(lic));
                await fetchAndMergeOfficialThemeSettings(copy);
                domainConfig = new Domain(copy);
            }
        } catch (err) {
            console.warn("[tags/domains/:domain] includeThemeSettings failed:", err.message);
        }
    }

    if (!domainConfig) {
        domainConfig = Module.getDomainConfig(domain);
    }

    if (!domainConfig) {
        ctx.status = 404;
        ctx.body = {
            code: "NotFound",
            message: "domain_not_found",
        };
        return;
    }

    ctx.body = { data: domainConfig };

    await next();
};

const getWalletBalances = async (ctx, next) => {
    try {
        const q = ctx.state.walletBalanceQuery || {};
        const data = await TagWalletBalancesModule.getTagWalletBalances({
            ethAddress: q.ethAddress,
            btcAddress: q.btcAddress,
            solanaAddress: q.solanaAddress,
        });
        ctx.body = { data };
    } catch (error) {
        console.error("getWalletBalances:", error);
        ctx.status = 500;
        ctx.body = { error: "wallet_balances_failed" };
        return;
    }

    await next();
};

module.exports = {
    searchTag,
    searchTagsByDomain,
    leaseTag,
    leaseRecovery,
    leaseOfflineTag,
    leaseConfirmation,
    previewTag,
    previewZelfProof,
    previewZelfIdQr,
    decryptTag,
    revenueCatWebhook,
    purchaseRewards,
    referralRewards,
    deleteTag,
    // Utility functions
    handleOldTagUpdate,

    // domains
    getDomains,
    getDomain,

    getWalletBalances,
};
