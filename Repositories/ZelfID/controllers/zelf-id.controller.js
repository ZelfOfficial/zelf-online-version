const Module = require("../modules/zelf-id.module");
const RevenueCatModule = require("../../Tags/modules/revenue-cat.module");
const RewardRoutesController = require("../../Tags/controllers/reward-routes.controller");
const { updateOldTagObject } = require("../../Tags/modules/my-tags.module");
const ZelfIdRecoveryModule = require("../modules/zelf-id-recovery.module");
const TagsSearchModule = require("../../Tags/modules/tags-search.module");
const { getAllSupportedDomains } = require("../../Tags/modules/domain-registry.module");
const { errorHandler } = require("../../../Core/http-handler");
const configuration = require("../../../Core/config");
const ZelfProofModule = require("../../ZelfProof/modules/zelf-proof.module");
const { resolveEncryptVersion } = require("../../Tags/modules/tags-addresses.module");
const { hasMissingOwner, applyPreviewPublicData } = require("../../Tags/modules/tag-preview-public-data");
const TagWalletBalancesModule = require("../../Tags/modules/tag-wallet-balances.module");
const MyZelfIdModule = require("../modules/my-zelf-id.module");
const ZelfIdsOfflineModule = require("../modules/zelf-ids-offline.module");
const ZelfIdsSyncAddressesModule = require("../modules/zelf-ids-sync-addresses.module");
const ZelfIdsStripeModule = require("../modules/zelf-ids-stripe.module");
const ZelfIdsRevenueCatModule = require("../modules/zelf-ids-revenue-cat.module");

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

const searchTag = async (ctx) => {
    try {
        const { extractedDomain, extractedName } = ctx.state;

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

const leaseOffline = async (ctx) => {
    try {
        const { extractedDomain, extractedName } = ctx.state;

        const requestData = {
            ...ctx.request.body,
            tagName: resolveFullTagNameForRequest(ctx.request.body.tagName, extractedName, extractedDomain),
            domain: extractedDomain,
        };

        const data = await ZelfIdsOfflineModule.leaseOffline(requestData, ctx.state.user);

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

const syncAddresses = async (ctx) => {
    try {
        const { extractedDomain, extractedName } = ctx.state;

        const requestData = {
            ...ctx.request.body,
            tagName: resolveFullTagNameForRequest(ctx.request.body.tagName, extractedName, extractedDomain),
            domain: extractedDomain,
        };

        ctx.body = await ZelfIdsSyncAddressesModule.syncAddresses(requestData, ctx.state.user);
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;

        ctx.body = { message: _exception.message, code: _exception.code };
        if (error.rejected) {
            ctx.body.rejected = error.rejected;
        }
    }
};

const leaseRecovery = async (ctx) => {
    try {
        const { extractedDomain, extractedName } = ctx.state;

        const requestData = {
            ...ctx.request.body,
            tagName: resolveFullTagNameForRequest(ctx.request.body.tagName, extractedName, extractedDomain),
            domain: extractedDomain,
        };

        const data = await ZelfIdRecoveryModule.leaseRecovery(requestData, ctx.state.user);

        ctx.body = { data };
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;

        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

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

const revenueCatWebhook = async (ctx) => {
    try {
        // The Tags revenue-cat module has no `revenueCatWebhook` export, so this
        // route always failed. Zelf IDs use their own v4 handler.
        const data = await ZelfIdsRevenueCatModule.confirmRevenueCatPurchase(ctx.request.body.event, {
            allowSandbox: configuration.env !== "production",
        });

        ctx.body = { data };
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;

        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

// RevenueCatModule has no purchaseRewards/referralRewards, so these always failed. Purchase
// rewards release the oldest pending Tags purchase reward; referral rewards answer 410 (paid per
// referral by POST /api/my-tags/referrals/claim). See Tags reward-routes.controller.js.
const purchaseRewards = RewardRoutesController.purchaseRewards;

const referralRewards = RewardRoutesController.referralRewardsRetired;

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
    const { Domain } = require("../../Tags/modules/domain.class");

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
            console.warn("[zelf-ids/domains/:domain] includeThemeSettings failed:", err.message);
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

const paymentOptions = async (ctx) => {
    try {
        const { tagName, domain, duration, plan } = ctx.request.query;
        const reducedFeeRequested = Boolean(ctx.state.reducedFeeRequested);
        const data = await MyZelfIdModule.getPaymentOptions(tagName, domain, duration, ctx.state.user, {
            reducedFeeRequested,
            requestedPlan: plan,
        });

        ctx.body = { data };
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;
        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

const paymentConfirmation = async (ctx) => {
    try {
        const { tagName, domain, network, token } = ctx.request.body;
        const data = await MyZelfIdModule.verifyPaymentConfirmation(tagName, domain, network, token);

        ctx.body = { data };
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;
        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

const smartContractPaymentConfirmation = async (ctx) => {
    try {
        const { tagName, domain, token, txHash, network } = ctx.request.body;
        const data = await MyZelfIdModule.verifySmartContractPayment(tagName, domain, token, txHash, network);

        ctx.body = { data };
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;
        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

const stripeCheckout = async (ctx) => {
    try {
        const { tagName, domain, duration, plan, token, locale, email } = ctx.request.body;
        const data = await ZelfIdsStripeModule.createStripeCheckout({
            tagName,
            domain,
            duration,
            plan,
            token,
            locale,
            email,
        });

        ctx.body = { data };
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;
        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

const stripeSession = async (ctx) => {
    try {
        const { sessionId } = ctx.request.query;
        const data = await ZelfIdsStripeModule.confirmFromSessionId(sessionId);

        ctx.body = { data };
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;
        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

module.exports = {
    searchTag,
    searchTagsByDomain,
    leaseTag,
    leaseOffline,
    syncAddresses,
    leaseRecovery,
    previewTag,
    previewZelfProof,
    previewZelfIdQr,
    decryptTag,
    revenueCatWebhook,
    purchaseRewards,
    referralRewards,
    deleteTag,
    handleOldTagUpdate,
    getDomains,
    getDomain,
    getWalletBalances,
    paymentOptions,
    paymentConfirmation,
    smartContractPaymentConfirmation,
    stripeCheckout,
    stripeSession,
};
