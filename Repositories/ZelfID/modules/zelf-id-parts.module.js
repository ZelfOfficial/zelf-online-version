const TagsPartsModule = require("../../Tags/modules/tags-parts.module");
const { encrypt, preview, encryptQRCode } = require("../../ZelfProof/modules/zelf-proof.module");
const { generateQRFromZelfProof } = require("../../Tags/modules/qr-zelfproof-extractor.module");
const { getDomainConfig } = require("../../Tags/config/supported-domains");
const config = require("../../../Core/config");
const { getZelfIdPrice } = require("./zelf-id-plan.module");

const withV4 = (data) => ({ ...data, stack: "v4" });

/**
 * Encrypt a Zelf ID proof on v4 and attach QR onto `tagObject`.
 * @param {Object} dataToEncrypt inbound for ZelfProof `encrypt` (`publicData`, `faceBase64`, `metadata`, `password?`, `addServerPassword?`, …)
 * @param {Object} tagObject mutated with `zelfProof` and `zelfProofQRCode`
 * @returns {Promise<void>}
 */
const generateZelfProof = async (dataToEncrypt, tagObject) => {
    const { zelfProof } = await encrypt(withV4(dataToEncrypt));

    tagObject.zelfProof = zelfProof;
    tagObject.zelfProofQRCode = await generateQRFromZelfProof(zelfProof);
};

/**
 * Encrypt params on v4 with the server verifier key.
 * Inbound: `faceBase64`, `password`, `metadata`, `tagName`, `domain`.
 *
 * @param {Object} params
 * @param {Object} authUser
 * @returns {Promise<Object>}
 */
const encryptParams = async (params, authUser) => {
    const { faceBase64, password, metadata, tagName, domain } = params;
    const domainConfig = getDomainConfig(domain);

    if (!domainConfig) {
        throw new Error(`Domain '${domain}' is not supported`);
    }

    const encryptedResult = await encrypt(
        withV4({
            faceBase64,
            password,
            metadata,
            verifierKey: config.zelfEncrypt.serverKey,
        })
    );

    if (encryptedResult.error) {
        const error = new Error(encryptedResult.error.code);
        error.status = 409;
        throw error;
    }

    return {
        zelfProof: encryptedResult.zelfProof,
        zelfProofQRCode: encryptedResult.zelfProofQRCode,
        tagName,
        domain,
        domainConfig,
    };
};

/**
 * Preview a proof on v4 with the server verifier key.
 * Inbound: `zelfProof`, `tagName`, `domain`.
 *
 * @param {Object} params
 * @returns {Promise<Object>}
 */
const previewTag = async (params) => {
    const { zelfProof, tagName, domain } = params;
    const domainConfig = getDomainConfig(domain);

    if (!domainConfig) {
        throw new Error(`Domain '${domain}' is not supported`);
    }

    const previewResult = await preview(
        withV4({
            zelfProof,
            verifierKey: config.zelfEncrypt.serverKey,
        })
    );

    return {
        preview: previewResult,
        tagName,
        domain,
        domainConfig,
    };
};

/**
 * QR-encrypt a proof on v4 with the server verifier key.
 * Inbound: `zelfProof`, `tagName`, `domain`.
 *
 * @param {Object} params
 * @returns {Promise<Object>}
 */
const generateQRCode = async (params) => {
    const { zelfProof, tagName, domain } = params;
    const domainConfig = getDomainConfig(domain);

    if (!domainConfig) {
        throw new Error(`Domain '${domain}' is not supported`);
    }

    const qrCodeResult = await encryptQRCode(
        withV4({
            zelfProof,
            verifierKey: config.zelfEncrypt.serverKey,
        })
    );

    return {
        qrCode: qrCodeResult,
        tagName,
        domain,
        domainConfig,
    };
};

/**
 * Same wallet assignment as Tags, then stamp the license quote and plan.
 * All names lease free; short names upgrade to unlimited only when they pay later.
 */
const assignProperties = (tagObject, dataToEncrypt, addresses, payload, domainConfig) => {
    TagsPartsModule.assignProperties(tagObject, dataToEncrypt, addresses, payload, domainConfig);

    const tagKey = domainConfig.tags?.storage?.keyPrefix || "tagName";
    const referralTagName = (
        payload.referralTagObject?.publicData?.[tagKey] ||
        payload.referralTagObject?.publicData?.tagName ||
        payload.referralTagObject?.publicData?.zelfName ||
        ""
    )
        .toString()
        .split(".")[0];

    const priced = getZelfIdPrice({
        tagName: tagObject[tagKey] || tagObject.tagName || tagObject.zelfName,
        duration: `${payload.duration || tagObject.duration || "1"}`,
        referralTagName: referralTagName ? `${referralTagName}.${domainConfig.name}` : "",
        domainConfig,
    });

    tagObject.price = priced.price;
    tagObject.reward = priced.reward;
    tagObject.discount = priced.discount;
    tagObject.discountType = priced.discountType;
};

module.exports = {
    ...TagsPartsModule,
    assignProperties,
    generateZelfProof,
    encryptParams,
    previewTag,
    generateQRCode,
};
