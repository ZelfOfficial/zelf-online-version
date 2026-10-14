const { string, number, boolean, validate, stringEnum, object } = require("../../../Core/JoiUtils");
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
    sync: boolean(),
    syncPublicData: object().unknown(true),
    syncPassword: string(),
    password: string(),
};

const syncAddressesSchema = {
    tagName: string().required(),
    domain: string().required(),
    zelfProofQRCode: string(),
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

    const { tagName, domain, zelfProof, zelfProofQRCode, sync, syncPublicData } = ctx.request.body;

    if (!zelfProof && !zelfProofQRCode) {
        ctx.status = 409;
        ctx.body = { validationError: "missing zelfProof" };
        return;
    }

    if (sync && !syncPublicData) {
        ctx.status = 409;
        ctx.body = { validationError: "missing syncPublicData" };
        return;
    }

    if (ctx.request.body.syncPassword && !ctx.request.body.password) {
        ctx.request.body.password = ctx.request.body.syncPassword;
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
        duration: string().required(), // allowed values come from the license planPricing
        plan: string().optional(), // offered plans come from the license planPricing
    },
    stripeCheckout: {
        tagName: string().required(),
        domain: string(),
        duration: string().required(), // allowed values come from the license planPricing
        plan: string().optional(), // "free" or a plan the license prices
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
        transaction_id: string().allow("", null),
        environment: string().required(),
        price: number().allow(null),
    },
};

const crypto = require("crypto");

const safeEqual = (a, b) => {
    const left = Buffer.from(String(a));
    const right = Buffer.from(String(b));
    return left.length === right.length && crypto.timingSafeEqual(left, right);
};

/**
 * RevenueCat sends the static Authorization header set in its dashboard (no JWT).
 * It must equal REVENUECAT_WEBHOOK_AUTHORIZATION (falls back to JIM_INBOX_API_KEY). "Bearer <secret>" and "<secret>" are
 * treated the same so either dashboard style works. Unset secret fails closed (503).
 */
const isRevenueCatAuthorized = (header, expected) => {
    if (!expected || !header) return false;
    const strip = (value) => String(value).trim().replace(/^Bearer\s+/i, "");
    return safeEqual(String(header).trim(), String(expected).trim()) || safeEqual(strip(header), strip(expected));
};

const revenueCatWebhookValidation = async (ctx, next) => {
    const expected = config.revenueCat?.webhookAuthorization;

    if (!expected) {
        ctx.status = 503;
        ctx.body = { validationError: "RevenueCat webhook is not configured" };
        return;
    }

    if (!isRevenueCatAuthorized(ctx.headers?.authorization, expected)) {
        ctx.status = 401;
        ctx.body = { validationError: "Invalid authorization" };
        return;
    }

    const event = ctx.request.body?.event;

    if (!event || typeof event !== "object") {
        ctx.status = 409;
        ctx.body = { validationError: "Missing event payload" };
        return;
    }

    // RevenueCat dashboard "Send test event": acknowledge with 200 and do nothing else (no DB writes).
    if (event.type === "TEST") {
        ctx.status = 200;
        ctx.body = { received: true, ignored: "test_event" };
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

/**
 * Duration/plan must be priced by the license for this name length (no hardcoded 1–5).
 * @returns {string|null} validation error, or null
 */
const licensePlanDurationError = (tagName, domain, plan, duration) => {
    const { getDomainConfig } = require("../../Tags/config/supported-domains");
    const { assertLicenseOffersPlan, resolvePaidPlan } = require("../modules/zelf-id-plan.module");
    const domainName = String(domain || String(tagName || "").split(".")[1] || "zelf").toLowerCase();
    const domainConfig = getDomainConfig(domainName);
    // An explicit paid plan is checked as-is (premium on a short name is rejected, not re-stamped).
    const checkedPlan = plan && plan !== "free" ? plan : resolvePaidPlan({ tagName, domainConfig });
    try {
        assertLicenseOffersPlan({ domainConfig, tagName, plan: checkedPlan, duration });
        return null;
    } catch (error) {
        return String(error.message || error).replace(/^409:/, "");
    }
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

    const planError = licensePlanDurationError(tagName, domain, ctx.request.query.plan, ctx.request.query.duration);
    if (planError) {
        ctx.status = 409;
        ctx.body = { validationError: planError };
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

    const planError = licensePlanDurationError(tagName, domain, ctx.request.body.plan, ctx.request.body.duration);
    if (planError) {
        ctx.status = 409;
        ctx.body = { validationError: planError };
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
