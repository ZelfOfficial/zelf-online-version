/**
 * Zelf ID v4 payment confirmation. Parallel to my-tags; does not patch it.
 */
const moment = require("moment");
const jwt = require("jsonwebtoken");
const config = require("../../../Core/config");
const { getDomainConfig } = require("../../Tags/config/supported-domains");
const { coerceInitiatedAtUnix } = require("../../Tags/modules/tag-pay-session-tx.util");
const {
    throwPaymentConfirmationTagNotFound,
    verifySmartContractPayment: verifyTagsSmartContractPayment,
} = require("../../Tags/modules/tag-smart-contract-payment.module");
const { confirmPayUniqueAddress } = require("../../Tags/modules/my-tags.module");
const ZelfIdModule = require("./zelf-id.module");
const ZelfIdsPaymentModule = require("./zelf-ids-payment.module");

const verifyPaymentConfirmation = async (tagName, domain, network, token) => {
    const tokenDecoded = jwt.verify(token, config.JWT_SECRET);
    const domainConfig = getDomainConfig(domain);

    if (!tokenDecoded || !tokenDecoded.tagName || !tokenDecoded.tagPayName) throw new Error("401:tag_not_authenticated");

    if (tokenDecoded.tagName !== `${tagName}.${domain}`) throw new Error("403:tag_not_owned");

    if (network === "AVAX") {
        throw new Error("409:avax_use_smart_contract_confirmation");
    }

    const tagData = await ZelfIdModule.searchTag({ tagName, domain, domainConfig, environment: "all" }, {});

    if (tagData.available) throwPaymentConfirmationTagNotFound(tagName, domain);

    const tagObject = tagData.tagObject;
    const amountToPay = tokenDecoded.prices[network]?.amountToSend;
    const initiatedAtUnix = coerceInitiatedAtUnix(tokenDecoded.initiatedAt);

    const addressMapping = {
        ETH: tokenDecoded.paymentAddress.ethAddress,
        SOL: tokenDecoded.paymentAddress.solanaAddress,
        BTC: tokenDecoded.paymentAddress.btcAddress,
        AVAX: tokenDecoded.paymentAddress.avalancheAddress || tokenDecoded.paymentAddress.ethAddress,
        BDAG: tokenDecoded.paymentAddress?.blockdagAddress || tokenDecoded.paymentAddress?.ethAddress,
    };

    const paymentConfirmation = await confirmPayUniqueAddress(network, addressMapping[network], amountToPay, { initiatedAtUnix });

    const initiatedAt = tokenDecoded.initiatedAt ? moment.unix(tokenDecoded.initiatedAt) : null;
    const renewedAtCondition = Boolean(tagObject.publicData.renewedAt && initiatedAt && moment(tagObject.publicData.renewedAt).isAfter(initiatedAt));
    const registeredAtCondition = Boolean(tokenDecoded.initiatedAt && moment(tagObject.publicData.registeredAt).isAfter(initiatedAt));

    if (renewedAtCondition || registeredAtCondition) {
        return {
            cache: true,
            confirmed: paymentConfirmation.confirmed,
            amountReceived: paymentConfirmation.amountReceived,
            paymentConfirmation,
            publicData: tagObject.publicData,
            expiresAt: tagObject.publicData?.expiresAt || null,
            tagObject,
        };
    }

    const paymentOk = paymentConfirmation && typeof paymentConfirmation === "object" && paymentConfirmation.confirmed === true;

    if (!paymentOk) {
        const _paymentConfirmation = paymentConfirmation && typeof paymentConfirmation === "object" ? paymentConfirmation : null;

        return {
            tagObject,
            confirmed: false,
            amountReceived: _paymentConfirmation?.amountReceived ?? 0,
            ...(_paymentConfirmation ? { paymentConfirmation: _paymentConfirmation } : {}),
        };
    }

    const extension = await addDurationToTag(
        {
            tagName: tagObject.publicData[domainConfig.getTagKey()].split(".")[0],
            price: amountToPay,
            domain,
            duration: tokenDecoded.duration || 1,
            plan: tokenDecoded.plan,
            domainConfig,
        },
        tagObject
    );

    if (extension.expiresAt && tagObject.publicData) {
        tagObject.publicData.expiresAt = extension.expiresAt;
    }

    return {
        tagObject: extension.tagObject || tagObject,
        expiresAt: extension.expiresAt || tagObject.publicData?.expiresAt || null,
        confirmed: true,
        amountReceived: paymentConfirmation.amountReceived,
    };
};

const persistZelfIdMetadata = async (params, tagObject, domainConfig, metadata) => {
    await ZelfIdsPaymentModule.ensureZelfProofQRCode(tagObject);

    if (domainConfig.isIPFSEnabled()) {
        await ZelfIdsPaymentModule.storeInIPFS(tagObject, domainConfig, metadata);
    }

    if (domainConfig.isArweaveEnabled()) {
        await ZelfIdsPaymentModule.storeInArweave(tagObject, domainConfig, metadata);
    }

    let expiresAt = null;
    try {
        if (metadata?.extraParams && typeof metadata.extraParams === "string") {
            const parsed = JSON.parse(metadata.extraParams);
            expiresAt = parsed.expiresAt || null;
            if (parsed.plan) {
                tagObject.publicData = { ...tagObject.publicData, plan: parsed.plan, expiresAt, eventID: parsed.eventID };
            }
            if (parsed.revenueCatOriginalTransactionId) {
                tagObject.publicData.revenueCatOriginalTransactionId = parsed.revenueCatOriginalTransactionId;
            }
        }
    } catch (_error) {
        /* optional */
    }

    const arweaveSkipped = Boolean(tagObject.arweave?.skipped);
    const warnings = [];
    if (arweaveSkipped && domainConfig.isArweaveEnabled()) {
        warnings.push("arweave_upload_skipped_file_too_large");
    }

    const ipfsRec = tagObject.ipfs;
    const arwRec = tagObject.arweave;

    return {
        tagObject,
        expiresAt,
        ipfsId: ipfsRec?.id ?? tagObject.ipfsId ?? null,
        arweaveId: arweaveSkipped ? null : arwRec?.id ?? null,
        masterIPFSRecord: ipfsRec,
        masterArweaveRecord: arweaveSkipped ? null : arwRec,
        arweaveSkipped,
        warnings,
    };
};

const addDurationToTag = async (params, tagObject) => {
    const { domain } = params;
    const domainConfig = params.domainConfig || getDomainConfig(domain || "zelf");
    const { metadata } = ZelfIdsPaymentModule.buildMetadata(params, tagObject, domainConfig);

    return persistZelfIdMetadata(params, tagObject, domainConfig, metadata);
};

const revertZelfIdToFreePlan = async (params, tagObject) => {
    const { domain } = params;
    const domainConfig = params.domainConfig || getDomainConfig(domain || "zelf");
    const { metadata } = ZelfIdsPaymentModule.buildFreePlanRevertMetadata(params, tagObject, domainConfig);

    return persistZelfIdMetadata(params, tagObject, domainConfig, metadata);
};

const getPaymentOptions = (tagName, domain, duration, authUser, requestOptions = {}) =>
    ZelfIdsPaymentModule.getPaymentOptions(tagName, domain, duration, authUser, requestOptions);

const verifySmartContractPayment = (tagName, domain, token, txHash, network) =>
    verifyTagsSmartContractPayment(tagName, domain, token, txHash, network);

module.exports = {
    verifyPaymentConfirmation,
    verifySmartContractPayment,
    addDurationToTag,
    revertZelfIdToFreePlan,
    getPaymentOptions,
};
