const { string, validate, boolean, number, stringEnum, stringOptionalEmptyAsNull } = require("../../../Core/JoiUtils");
const Session = require("../../Session/models/session.model");
const moment = require("moment");
const { extractDomainAndName, validateDomainAndName } = require("./tags.middleware");
const jwt = require("jsonwebtoken");
const config = require("../../../Core/config");
const TagsPaymentModule = require("../modules/tags-payment.module");

const TAG_PAY_REDUCED_FEE_HEADER = "x-zelf-tag-pay-reduced-fee";

const schemas = {
    transfer: {
        tagName: string().required(),
        domain: string(),
        faceBase64: string().required(),
        password: string().allow("", null),
        newOwnerEmail: string().email().allow("", null),
        transferMessage: string().allow("", null),
        os: stringEnum(["DESKTOP", "ANDROID", "IOS"]),
        captchaToken: stringOptionalEmptyAsNull().optional(),
    },
    paymentConfirmation: {
        tagName: string().required(),
        domain: string(),
        network: stringEnum(["ETH", "SOL", "BTC", "AVAX", "BNB", "POL", "BASE", "BDAG"]).required(),
        token: string().required(),
    },
    smartContractPaymentConfirmation: {
        tagName: string().required(),
        domain: string(),
        network: stringEnum(["AVAX_SC", "BSC_SC", "ETH_SC", "POLYGON_SC", "BASE_SC", "BLOCKDAG_SC"]).required(),
        token: string().required(),
        txHash: string().required(),
    },
    paymentOptions: {
        tagName: string().required(),
        domain: string(),
        duration: stringEnum(["1", "2", "3", "4", "5", "lifetime"]).required(),
    },
    receiptEmail: {
        tagName: string().required(),
        domain: string(),
        network: stringEnum(["ETH", "SOL", "BTC", "AVAX", "BNB", "POL", "BASE", "BDAG"]).required(),
        email: string().email().required(),
        token: string().required(),
    },
    referrals: {
        tagName: string().required(),
        domain: string().required(),
    },
    claimReferral: {
        tagName: string().required(),
        domain: string().required(),
        friendTagName: string().required(),
        friendDomain: string().required(),
        rewardType: string(),
    },
    extendLicenseForOwner: {
        tagName: string().required(),
        domain: string().required(),
        duration: stringEnum(["1", "2", "3", "4", "5", "lifetime"]).required(),
        faceBase64: string().required(),
        password: string(),
    },
};

/**
 * Transfer Validation - Multi-domain support
 * @param {*} ctx - Koa context
 * @param {*} next - Next middleware
 */
const transferValidation = async (ctx, next) => {
    const valid = validate(schemas.transfer, ctx.request.body);

    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    const { tagName, domain } = ctx.request.body;

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
 * Payment Options Validation - Multi-domain support
 * @param {*} ctx - Koa context
 * @param {*} next - Next middleware
 */
const paymentOptionsValidation = async (ctx, next) => {
    const valid = validate(schemas.paymentOptions, ctx.request.query);

    if (valid.error) {
        ctx.status = 409;

        ctx.body = { validationError: valid.error.message };

        return;
    }

    const { tagName, domain } = ctx.request.query;

    const domainValidation = await validateDomainAndName(domain, tagName);

    if (!domainValidation.valid) {
        ctx.status = 409;
        ctx.body = { validationError: domainValidation.error };
        return;
    }

    await next();
};

/**
 * Honor `X-Zelf-Tag-Pay-Reduced-Fee` only when the server opts in; strip the header otherwise so it cannot be abused downstream.
 * Sets `ctx.state.reducedFeeRequested` for the payment-options handler.
 */
const paymentOptionsReducedFeeGate = async (ctx, next) => {
    const raw = String(ctx.get(TAG_PAY_REDUCED_FEE_HEADER) || "").toLowerCase();
    const headerWantsReduced = raw === "1" || raw === "true" || raw === "yes";
    const honored = TagsPaymentModule.isTagPayReducedFeeClientHeaderHonored();

    ctx.state.reducedFeeRequested = Boolean(headerWantsReduced && honored);

    if (headerWantsReduced && !honored) {
        delete ctx.request.headers[TAG_PAY_REDUCED_FEE_HEADER];
        if (ctx.req?.headers) {
            delete ctx.req.headers[TAG_PAY_REDUCED_FEE_HEADER];
        }
    }

    await next();
};

/**
 * Payment Confirmation Validation - Multi-domain support
 * @param {*} ctx - Koa context
 * @param {*} next - Next middleware
 */
const paymentConfirmationValidation = async (ctx, next) => {
    const valid = validate(schemas.paymentConfirmation, ctx.request.body);

    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    const { tagName, domain, token, network } = ctx.request.body;

    const domainValidation = await validateDomainAndName(domain, tagName);

    if (!domainValidation.valid) {
        ctx.status = 409;
        ctx.body = { validationError: domainValidation.error };
        return;
    }

    let tokenDecoded;

    try {
        tokenDecoded = jwt.verify(token, config.JWT_SECRET);
    } catch {
        ctx.status = 409;
        ctx.body = { validationError: "invalid_token" };
        return;
    }

    if (!tokenDecoded) {
        ctx.status = 409;
        ctx.body = { validationError: "invalid_token" };
        return;
    }

    // now validate tokenDecoded.ttl is still valid
    // TEMPORARY: Simulate 2 hours in the future for testing
    //.add(2, "hours")
    const now = moment().unix();

    if (tokenDecoded.ttl < now) {
        ctx.status = 409;
        ctx.body = { validationError: "token_expired" };
        return;
    }

    // now validate the network and coin
    if (!tokenDecoded.prices[network]) {
        ctx.status = 409;
        ctx.body = { validationError: "invalid_network" };
        return;
    }

    await next();
};

const smartContractPaymentConfirmationValidation = async (ctx, next) => {
    const valid = validate(schemas.smartContractPaymentConfirmation, ctx.request.body);

    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    const { tagName, domain, token } = ctx.request.body;

    const domainValidation = await validateDomainAndName(domain, tagName);

    if (!domainValidation.valid) {
        ctx.status = 409;
        ctx.body = { validationError: domainValidation.error };
        return;
    }

    let tokenDecoded;

    try {
        tokenDecoded = jwt.verify(token, config.JWT_SECRET);
    } catch {
        ctx.status = 409;
        ctx.body = { validationError: "invalid_token" };
        return;
    }

    if (!tokenDecoded) {
        ctx.status = 409;
        ctx.body = { validationError: "invalid_token" };
        return;
    }

    const now = moment().unix();

    if (tokenDecoded.ttl < now) {
        ctx.status = 409;
        ctx.body = { validationError: "token_expired" };
        return;
    }

    const { network } = ctx.request.body;

    if (network === "BLOCKDAG_SC") {
        const scBd = tokenDecoded.smartContractBDAG;
        const hasNative =
            scBd?.expectedWei != null &&
            String(scBd.expectedWei).trim() !== "" &&
            (() => {
                try {
                    return BigInt(scBd.expectedWei) > 0n;
                } catch {
                    return false;
                }
            })();

        if (!scBd?.paymentId || !hasNative) {
            ctx.status = 409;
            ctx.body = { validationError: "smart_contract_bdag_not_in_token" };
            return;
        }

        await next();
        return;
    }

    if (network === "ETH_SC") {
        const scE = tokenDecoded.smartContractETH;
        const hasNative =
            scE?.expectedWei != null &&
            String(scE.expectedWei).trim() !== "" &&
            (() => {
                try {
                    return BigInt(scE.expectedWei) > 0n;
                } catch {
                    return false;
                }
            })();
        const hasUsdc =
            scE?.usdc?.expectedAmount != null &&
            String(scE.usdc.expectedAmount).trim() !== "" &&
            scE?.usdc?.tokenAddress &&
            (() => {
                try {
                    return BigInt(scE.usdc.expectedAmount) > 0n;
                } catch {
                    return false;
                }
            })();
        const hasUsdt =
            scE?.usdt?.expectedAmount != null &&
            String(scE.usdt.expectedAmount).trim() !== "" &&
            scE?.usdt?.tokenAddress &&
            (() => {
                try {
                    return BigInt(scE.usdt.expectedAmount) > 0n;
                } catch {
                    return false;
                }
            })();

        if (!scE?.paymentId || (!hasNative && !hasUsdc && !hasUsdt)) {
            ctx.status = 409;
            ctx.body = { validationError: "smart_contract_eth_not_in_token" };
            return;
        }

        await next();
        return;
    }

    if (network === "POLYGON_SC") {
        const scP = tokenDecoded.smartContractPOLYGON;
        const hasNative =
            scP?.expectedWei != null &&
            String(scP.expectedWei).trim() !== "" &&
            (() => {
                try {
                    return BigInt(scP.expectedWei) > 0n;
                } catch {
                    return false;
                }
            })();
        const hasUsdc =
            scP?.usdc?.expectedAmount != null &&
            String(scP.usdc.expectedAmount).trim() !== "" &&
            scP?.usdc?.tokenAddress &&
            (() => {
                try {
                    return BigInt(scP.usdc.expectedAmount) > 0n;
                } catch {
                    return false;
                }
            })();
        const hasUsdt =
            scP?.usdt?.expectedAmount != null &&
            String(scP.usdt.expectedAmount).trim() !== "" &&
            scP?.usdt?.tokenAddress &&
            (() => {
                try {
                    return BigInt(scP.usdt.expectedAmount) > 0n;
                } catch {
                    return false;
                }
            })();

        if (!scP?.paymentId || (!hasNative && !hasUsdc && !hasUsdt)) {
            ctx.status = 409;
            ctx.body = { validationError: "smart_contract_polygon_not_in_token" };
            return;
        }

        await next();
        return;
    }

    if (network === "BASE_SC") {
        const scBase = tokenDecoded.smartContractBASE;
        const hasNative =
            scBase?.expectedWei != null &&
            String(scBase.expectedWei).trim() !== "" &&
            (() => {
                try {
                    return BigInt(scBase.expectedWei) > 0n;
                } catch {
                    return false;
                }
            })();
        const hasUsdc =
            scBase?.usdc?.expectedAmount != null &&
            String(scBase.usdc.expectedAmount).trim() !== "" &&
            scBase?.usdc?.tokenAddress &&
            (() => {
                try {
                    return BigInt(scBase.usdc.expectedAmount) > 0n;
                } catch {
                    return false;
                }
            })();
        const hasUsdt =
            scBase?.usdt?.expectedAmount != null &&
            String(scBase.usdt.expectedAmount).trim() !== "" &&
            scBase?.usdt?.tokenAddress &&
            (() => {
                try {
                    return BigInt(scBase.usdt.expectedAmount) > 0n;
                } catch {
                    return false;
                }
            })();

        if (!scBase?.paymentId || (!hasNative && !hasUsdc && !hasUsdt)) {
            ctx.status = 409;
            ctx.body = { validationError: "smart_contract_base_not_in_token" };
            return;
        }

        await next();
        return;
    }

    if (network === "BSC_SC") {
        const scB = tokenDecoded.smartContractBSC;
        const hasNative =
            scB?.expectedWei != null &&
            String(scB.expectedWei).trim() !== "" &&
            (() => {
                try {
                    return BigInt(scB.expectedWei) > 0n;
                } catch {
                    return false;
                }
            })();
        const hasUsdc =
            scB?.usdc?.expectedAmount != null &&
            String(scB.usdc.expectedAmount).trim() !== "" &&
            scB?.usdc?.tokenAddress &&
            (() => {
                try {
                    return BigInt(scB.usdc.expectedAmount) > 0n;
                } catch {
                    return false;
                }
            })();
        const hasUsdt =
            scB?.usdt?.expectedAmount != null &&
            String(scB.usdt.expectedAmount).trim() !== "" &&
            scB?.usdt?.tokenAddress &&
            (() => {
                try {
                    return BigInt(scB.usdt.expectedAmount) > 0n;
                } catch {
                    return false;
                }
            })();

        if (!scB?.paymentId || (!hasNative && !hasUsdc && !hasUsdt)) {
            ctx.status = 409;
            ctx.body = { validationError: "smart_contract_bsc_not_in_token" };
            return;
        }

        await next();
        return;
    }

    const scA = tokenDecoded.smartContractAVAX;
    const hasNative =
        scA?.expectedWei != null &&
        String(scA.expectedWei).trim() !== "" &&
        (() => {
            try {
                return BigInt(scA.expectedWei) > 0n;
            } catch {
                return false;
            }
        })();
    const hasUsdc =
        scA?.usdc?.expectedAmount != null &&
        String(scA.usdc.expectedAmount).trim() !== "" &&
        scA?.usdc?.tokenAddress &&
        (() => {
            try {
                return BigInt(scA.usdc.expectedAmount) > 0n;
            } catch {
                return false;
            }
        })();

    if (!scA?.paymentId || (!hasNative && !hasUsdc)) {
        ctx.status = 409;
        ctx.body = { validationError: "smart_contract_avax_not_in_token" };
        return;
    }

    await next();
};

const receiptEmailValidation = async (ctx, next) => {
    const { network, token } = ctx.request.body;

    const valid = validate(schemas.receiptEmail, ctx.request.body);

    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    let tokenDecoded;

    try {
        tokenDecoded = jwt.verify(token, config.JWT_SECRET);
    } catch {
        ctx.status = 409;
        ctx.body = { validationError: "invalid_token" };
        return;
    }

    if (!tokenDecoded) {
        ctx.status = 409;
        ctx.body = { validationError: "invalid_token" };
        return;
    }

    // now validate the network and coin
    if (!tokenDecoded.prices[network]) {
        ctx.status = 409;
        ctx.body = { validationError: "invalid_network" };
        return;
    }

    await next();
};

const referralsValidation = async (ctx, next) => {
    const valid = validate(schemas.referrals, ctx.request.query);

    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    await next();
};

const claimReferralValidation = async (ctx, next) => {
    const valid = validate(schemas.claimReferral, ctx.request.body);

    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    await next();
};

/**
 * Extend License For Owner Validation
 * @param {*} ctx - Koa context
 * @param {*} next - Next middleware
 */
const extendLicenseForOwnerValidation = async (ctx, next) => {
    // If duration comes as a number, convert it to string to avoid Joi validation errors
    if (typeof ctx.request.body?.duration === "number") {
        ctx.request.body.duration = String(ctx.request.body.duration);
    }

    const valid = validate(schemas.extendLicenseForOwner, ctx.request.body);

    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    const { tagName, domain } = ctx.request.body;

    const domainValidation = await validateDomainAndName(domain, tagName);

    if (!domainValidation.valid) {
        ctx.status = 409;
        ctx.body = { validationError: domainValidation.error };
        return;
    }

    await next();
};

module.exports = {
    transferValidation,
    paymentOptionsValidation,
    paymentOptionsReducedFeeGate,
    paymentConfirmationValidation,
    smartContractPaymentConfirmationValidation,
    receiptEmailValidation,
    referralsValidation,
    claimReferralValidation,
    extendLicenseForOwnerValidation,
};
