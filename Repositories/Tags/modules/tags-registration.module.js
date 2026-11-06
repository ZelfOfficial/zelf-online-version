const WalrusModule = require("../../Walrus/modules/walrus.module");
const TagsIPFSModule = require("./tags-ipfs.module");
const TagsArweaveModule = require("./tags-arweave.module");
const { getDomainConfig } = require("../config/supported-domains");
const { formatLeaseDate } = require("./lease-date.util");
const { cleanExtraParamsForPinata, resolveEncryptVersion, stampExtraParamsVersion } = require("./tags-addresses.module");

/**
 * Confirm free tag (for recovery)
 * @param {Object} tagObject - Tag object
 * @param {Object} referralTagObject - Referral tag object
 * @param {Object} domainConfig - Domain config
 * @param {Object} authUser - Authenticated user
 */
const confirmFreeTag = async (tagObject, referralTagObject, domainConfig, securityType, authUser) => {
    const storageKey = domainConfig.getTagKey() || "tagName";

    const tagName = tagObject[storageKey] || tagObject.tagName || tagObject.zelfName;

    const domain = tagObject.domain || "zelf";

    const metadata = {
        [storageKey]: tagName,
        domain,
        extraParams: stampExtraParamsVersion(
            {
                origin: tagObject.origin || "online",
                price: tagObject.price,
                duration: 1,
                registeredAt: formatLeaseDate(),
                expiresAt: formatLeaseDate(1, "year"),
                type: "mainnet",
                hasPassword: tagObject.hasPassword,
            },
            resolveEncryptVersion(tagObject)
        ),
    };

    if (securityType && tagObject.hasPassword == "true") {
        metadata.extraParams.st = securityType;
    }

    if (referralTagObject) {
        metadata.referral = {
            tagName: referralTagObject.publicData?.[storageKey] || referralTagObject.metadata?.[storageKey],
            solanaAddress: referralTagObject.publicData?.solanaAddress || referralTagObject.metadata?.solanaAddress,
        };

        metadata.referralTagName = metadata.referral.tagName;

        metadata.referral = JSON.stringify(metadata.referral);
    }

    metadata.extraParams = JSON.stringify(cleanExtraParamsForPinata(metadata.extraParams));

    // only add it if the domain supports it
    if (domainConfig.isWalrusEnabled()) {
        tagObject.walrus = await WalrusModule.tagRegistration(
            tagObject.zelfProofQRCode,
            { hasPassword: metadata.hasPassword, zelfProof: metadata.zelfProof, publicData: metadata },
            domainConfig
        );

        metadata.walrus = tagObject.walrus.blobId;
    }

    tagObject.ipfs = await TagsIPFSModule.insertSearchablePins(
        {
            base64: tagObject.zelfProofQRCode,
            name: tagObject[storageKey],
            reserved: metadata,
            addresses: tagObject,
            pinIt: true,
        },
        { ...authUser, pro: true }
    );

    if (domainConfig.isArweaveEnabled()) {
        tagObject.arweave = await TagsArweaveModule.tagRegistration(tagObject.zelfProofQRCode, {
            hasPassword: metadata.hasPassword,
            zelfProof: metadata.zelfProof,
            publicData: metadata,
            fileName: tagName,
        });
    }
};

/**
 * Save hold tag in IPFS (for recovery)
 * @param {Object} tagObject - Tag object
 * @param {Object} referralTagObject - Referral tag object
 * @param {Object} domainConfig - Domain config
 * @param {string} securityType - Security type
 * @param {Object} authUser - Authenticated user
 */
const saveHoldTagInIPFS = async (tagObject, referralTagObject, domainConfig, securityType, authUser) => {
    const domain = tagObject.domain || "zelf";

    const _domainConfig = domainConfig || getDomainConfig(domain);

    const holdSuffix = _domainConfig?.holdSuffix || ".hold";

    const tagKey = _domainConfig.getTagKey() || "tagName";

    const tagName = tagObject[tagKey] || tagObject.tagName || tagObject.zelfName;

    const holdName = `${tagName}${holdSuffix}`;

    const metadata = {
        [tagKey]: holdName,
        domain,
        extraParams: stampExtraParamsVersion(
            {
                hasPassword: tagObject.hasPassword,
                type: "hold",
                origin: tagObject.origin || "online",
                registeredAt: formatLeaseDate(),
                expiresAt: formatLeaseDate(30, "day"),
            },
            resolveEncryptVersion(tagObject)
        ),
    };

    if (securityType && tagObject.hasPassword == "true") {
        metadata.extraParams.st = securityType;
    }

    if (referralTagObject) {
        metadata.referral = {
            tagName: referralTagObject.publicData?.[tagKey] || referralTagObject.metadata?.[tagKey],
            solanaAddress: referralTagObject.publicData?.solanaAddress || referralTagObject.metadata?.solanaAddress,
        };

        metadata.referralTagName = metadata.referral.tagName;

        metadata.referral = JSON.stringify(metadata.referral);
    }

    metadata.extraParams = JSON.stringify(cleanExtraParamsForPinata(metadata.extraParams));

    tagObject.ipfs = await TagsIPFSModule.insertSearchablePins(
        {
            base64: tagObject.zelfProofQRCode,
            name: holdName,
            reserved: metadata,
            addresses: tagObject,
            pinIt: true,
        },
        { ...authUser, pro: true }
    );
};

module.exports = {
    confirmFreeTag,
    saveHoldTagInIPFS,
};
