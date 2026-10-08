const { string, number, validate, stringEnum } = require("../../../Core/JoiUtils");
const jwt = require("jsonwebtoken");
const moment = require("moment");
const config = require("../../../Core/config");
const TagsMiddleware = require("../../Tags/middlewares/tags.middleware");
const TagsMyMiddleware = require("../../Tags/middlewares/my-tags.middleware");
const ZelfIdsPaymentModule = require("../modules/zelf-ids-payment.module");

const TAG_PAY_REDUCED_FEE_HEADER = "x-zelf-tag-pay-reduced-fee";

const leaseOfflineSchema = {
    tagName: string().required(),
    domain: string().required(),
    zelfProof: string(),
    zelfProofQRCode: string(),
    referralTagName: string(),
    duration: string(),
};

const syncAddressesSchema = {
    tagName: string().required(),
    domain: string().required(),
    syncPublicData: object({
        _syncSignature: string().required(),
        _syncIssuedAt: string().required(),
    }).unknown(true),
};

const syncAddressesValidation = async (ctx, next) => {
    const valid = validate(syncAddressesSchema, ctx.request.body);

    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    const { tagName, domain } = ctx.request.body;
    const { domain: extractedDomain, name } = TagsMiddleware.extractDomainAndName(tagName, domain);
    const domainValidation = await TagsMiddleware.validateDomainAndName(extractedDomain, name);

    if (!domainValidation.valid) {
        ctx.status = 409;
        ctx.body = { validationError: domainValidation.error };
        return;
    }

    ctx.state.extractedDomain = extractedDomain;
    ctx.state.extractedName = name;

    await next();
};

const leaseOfflineValidation = async (ctx, next) => {
    const valid = validate(leaseOfflineSchema, ctx.request.body);

    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    const { tagName, domain, zelfProof, zelfProofQRCode } = ctx.request.body;

    if (!zelfProof && !zelfProofQRCode) {
        ctx.status = 409;
        ctx.body = { validationError: "missing zelfProof" };
        return;
    }

    const { domain: extractedDomain, name } = TagsMiddleware.extractDomainAndName(tagName, domain);
    const domainValidation = await TagsMiddleware.validateDomainAndName(extractedDomain, name);

    if (!domainValidation.valid) {
        ctx.status = 409;
        ctx.body = { validationError: domainValidation.error };
        return;
    }

    ctx.state.extractedDomain = extractedDomain;
    ctx.state.extractedName = name;

    await next();
};

const paymentSchemas = {
    paymentConfirmation: {
        tagName: string().required(),
        domain: string(),
        network: stringEnum(["ETH", "SOL", "BTC", "AVAX", "BNB", "POL", "BASE", "BDAG"]).required(),
        token: string().required(),
    },
    paymentOptions: {
        tagName: string().required(),
        domain: string(),
        duration: stringEnum(["1", "2", "3", "4", "5", "lifetime"]).required(),
        plan: stringEnum(["premium", "unlimited"]).optional(),
    },
    stripeCheckout: {
        tagName: string().required(),
        domain: string(),
        duration: stringEnum(["1", "2", "3", "4", "5", "lifetime"]).required(),
        plan: stringEnum(["premium", "unlimited", "free"]).optional(),
        token: string().required(),
        locale: string(),
        email: string(),
    },
    stripeSession: {
        sessionId: string().required(),
    },
    revenueCatEvent: {
        type: string().required(),
        id: string().required(),
        product_id: string().required(),
        transaction_id: string().required(),
        environment: string().required(),
        price: number().allow(null),
    },
};

/**
 * RevenueCat calls this with the Authorization header set in its dashboard.
 * In production only the RevenueCat client JWT (REVENUECAT_ALLOWED_EMAIL) may
 * call it: session tokens are free to mint, and the event extends a Zelf ID.
 */
const revenueCatWebhookValidation = async (ctx, next) => {
    const { clientId, email } = ctx.state.user || {};
    const allowedEmail = config.revenueCat?.allowedEmail;

    if (config.env === "production" && (!clientId || !allowedEmail || email !== allowedEmail)) {
        ctx.status = 403;
        ctx.body = { validationError: "Access forbidden" };
        return;
    }

    const event = ctx.request.body?.event;

    if (!event || typeof event !== "object") {
        ctx.status = 409;
        ctx.body = { validationError: "Missing event payload" };
        return;
    }

    const valid = validate(paymentSchemas.revenueCatEvent, event);

    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    await next();
};

const paymentOptionsValidation = async (ctx, next) => {
    const duration = `${ctx.request.query.duration ?? ""}`.trim();
    if (duration === "999") {
        ctx.request.query = { ...ctx.request.query, duration: "lifetime" };
    }

    const valid = validate(paymentSchemas.paymentOptions, ctx.request.query);

    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    const { tagName, domain } = ctx.request.query;
    const domainValidation = await TagsMiddleware.validateDomainAndName(domain, tagName);

    if (!domainValidation.valid) {
        ctx.status = 409;
        ctx.body = { validationError: domainValidation.error };
        return;
    }

    await next();
};

const paymentOptionsReducedFeeGate = async (ctx, next) => {
    const raw = String(ctx.get(TAG_PAY_REDUCED_FEE_HEADER) || "").toLowerCase();
    const headerWantsReduced = raw === "1" || raw === "true" || raw === "yes";
    const honored = ZelfIdsPaymentModule.isTagPayReducedFeeClientHeaderHonored();

    ctx.state.reducedFeeRequested = Boolean(headerWantsReduced && honored);

    await next();
};

const stripeCheckoutValidation = async (ctx, next) => {
    const duration = `${ctx.request.body?.duration ?? ""}`.trim();
    if (duration === "999") {
        ctx.request.body = { ...ctx.request.body, duration: "lifetime" };
    }

    const valid = validate(paymentSchemas.stripeCheckout, ctx.request.body);

    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    const { tagName, domain } = ctx.request.body;
    const domainValidation = await TagsMiddleware.validateDomainAndName(domain, tagName);

    if (!domainValidation.valid) {
        ctx.status = 409;
        ctx.body = { validationError: domainValidation.error };
        return;
    }

    await next();
};

const stripeSessionValidation = async (ctx, next) => {
    const valid = validate(paymentSchemas.stripeSession, ctx.request.query);

    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    await next();
};

const paymentConfirmationValidation = async (ctx, next) => {
    const valid = validate(paymentSchemas.paymentConfirmation, ctx.request.body);

    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    const { tagName, domain, token, network } = ctx.request.body;
    const domainValidation = await TagsMiddleware.validateDomainAndName(domain, tagName);

    if (!domainValidation.valid) {
        ctx.status = 409;
        ctx.body = { validationError: domainValidation.error };
        return;
    }

    const tokenDecoded = jwt.verify(token, config.JWT_SECRET);

    if (!tokenDecoded) {
        ctx.status = 409;
        ctx.body = { validationError: "invalid_token" };
        return;
    }

    if (tokenDecoded.ttl < moment().unix()) {
        ctx.status = 409;
        ctx.body = { validationError: "token_expired" };
        return;
    }

    if (!tokenDecoded.prices[network]) {
        ctx.status = 409;
        ctx.body = { validationError: "invalid_network" };
        return;
    }

    await next();
};

module.exports = {
    getValidation: TagsMiddleware.getValidation,
    searchByDomainValidation: TagsMiddleware.searchByDomainValidation,
    leaseValidation: TagsMiddleware.leaseValidation,
    leaseOfflineValidation,
    syncAddressesValidation,
    leaseRecoveryValidation: TagsMiddleware.leaseRecoveryValidation,
    deleteTagValidation: TagsMiddleware.deleteTagValidation,
    previewValidation: TagsMiddleware.previewValidation,
    previewZelfProofValidation: TagsMiddleware.previewZelfProofValidation,
    previewZelfIdQrValidation: TagsMiddleware.previewZelfIdQrValidation,
    decryptValidation: TagsMiddleware.decryptValidation,
    revenueCatWebhookValidation,
    referralRewardsValidation: TagsMiddleware.referralRewardsValidation,
    purchaseRewardsValidation: TagsMiddleware.purchaseRewardsValidation,
    walletBalancesValidation: TagsMiddleware.walletBalancesValidation,
    extractDomainAndName: TagsMiddleware.extractDomainAndName,
    validateDomainAndName: TagsMiddleware.validateDomainAndName,
    paymentOptionsValidation,
    paymentOptionsReducedFeeGate,
    paymentConfirmationValidation,
    stripeCheckoutValidation,
    stripeSessionValidation,
    smartContractPaymentConfirmationValidation: TagsMyMiddleware.smartContractPaymentConfirmationValidation,
};
