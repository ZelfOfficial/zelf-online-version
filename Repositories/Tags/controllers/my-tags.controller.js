const Module = require("../modules/my-tags.module");
const { getDomainConfig } = require("../config/supported-domains");
const TagsPaymentModule = require("../modules/tags-payment.module");
const { errorHandler } = require("../../../Core/http-handler");
/**
 * Transfer tag
 * @param {Object} ctx - Koa context
 * @returns {Object} - Transfer results
 */
const transferTag = async (ctx) => {
    try {
        const { extractedDomain, extractedName } = ctx.state;
        const domainConfig = getDomainConfig(extractedDomain);

        const requestData = {
            ...ctx.request.body,
            tagName: extractedName ? `${extractedName}.${extractedDomain}` : ctx.request.body.tagName,
            domain: extractedDomain,
            domainConfig,
        };

        const data = await Module.transferMyTag(requestData, ctx.state.user);

        ctx.body = { data };
    } catch (error) {
        console.error({ error });

        ctx.status = error.status || 500;

        ctx.body = { error: error.message };
    }
};

/**
 * Renew tag
 * @param {Object} ctx - Koa context
 * @returns {Object} - Renewal results
 */
const paymentConfirmation = async (ctx) => {
    try {
        const { tagName, domain, network, token } = ctx.request.body;

        const data = await Module.verifyPaymentConfirmation(tagName, domain, network, token);

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

        const data = await Module.verifySmartContractPayment(tagName, domain, token, txHash, network);

        ctx.body = { data };
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;

        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

/**
 * Payment options
 * @param {Object} ctx - Koa context
 * @returns {Object} - Renewal instructions
 */
const paymentOptions = async (ctx) => {
    try {
        const { tagName, domain, duration, plan } = ctx.request.query;

        const reducedFeeRequested = Boolean(ctx.state.reducedFeeRequested);

        const data = await TagsPaymentModule.getPaymentOptions(tagName, domain, duration, ctx.state.user, {
            reducedFeeRequested,
            plan,
        });

        ctx.body = { data };
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;

        ctx.body = {
            message: _exception.message,
            code: _exception.code,
        };
    }
};

const receiptEmail = async (ctx) => {
    try {
        const { tagName, domain, network, email, token } = ctx.request.body;

        const data = await Module.sendEmailReceipt(tagName, domain, network, email, token);

        ctx.body = { data, payload: { tagName, domain, network, token } };
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;

        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

const referrals = async (ctx) => {
    try {
        const { tagName, domain } = ctx.request.query;

        const data = await Module.getMyReferrals(tagName, domain, ctx.state.user);

        ctx.body = { data };
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;

        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

const claimReferralReward = async (ctx) => {
    try {
        const { tagName, domain, friendTagName, friendDomain, rewardType } = ctx.request.body;

        const data = await Module.claimReferralReward(tagName, domain, friendTagName, friendDomain, ctx.state.user, rewardType);

        // Broadcast but not confirmed yet: accepted, settled later from the stored signature.
        if (data?.pending) ctx.status = 202;

        ctx.body = { data };
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;

        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

/**
 * Extend license for domain owner (free extension)
 * @param {Object} ctx - Koa context
 * @returns {Object} - Extension results
 */
const extendLicenseForOwner = async (ctx) => {
    try {
        const { tagName, domain, duration, faceBase64, password } = ctx.request.body;

        const data = await Module.extendLicenseForOwner(tagName, domain, duration, { faceBase64, password }, ctx.state.user);

        ctx.body = { data };
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;

        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

module.exports = {
    transferTag,
    paymentConfirmation,
    smartContractPaymentConfirmation,
    paymentOptions,
    receiptEmail,
    referrals,
    claimReferralReward,
    extendLicenseForOwner,
};
