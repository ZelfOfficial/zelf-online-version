/**
 * POST `/api/zelf-ids/sync-addresses` — publish wallet-derived addresses without decrypting the Zelf proof.
 */
const { getDomainConfig } = require("../../Tags/config/supported-domains");
const ZelfIdModule = require("./zelf-id.module");
const {
    normalizeTagName,
    listSyncAddressKeys,
    applyAddressSyncToRecord,
    verifyAddressSyncOwnership,
    throwNoAddressesToSync,
    partitionSyncAddresses,
} = require("./zelf-ids-address-sync.module");

/**
 * @param {Object} params
 * @param {string} params.tagName
 * @param {string} params.domain
 * @param {Object} params.syncPublicData
 * @param {Object} authUser
 * @returns {Promise<{ updated: string[], rejected: Record<string, string> }>}
 */
const syncAddresses = async (params, authUser) => {
    const { tagName, domain, syncPublicData } = params;
    if (!listSyncAddressKeys(syncPublicData).length) {
        throwNoAddressesToSync();
    }

    const domainConfig = getDomainConfig(domain);

    if (!domainConfig) {
        const error = new Error("409:unsupported_domain");
        error.status = 409;
        throw error;
    }

    const normalizedTagName = normalizeTagName(tagName, domain);
    const tagKey = domainConfig.getTagKey() || "tagName";

    const searchResult = await ZelfIdModule.searchTag(
        {
            tagName: normalizedTagName,
            domain,
            domainConfig,
            environment: "all",
            includeAllAddressPages: true,
        },
        authUser
    );

    if (searchResult.available || !searchResult.tagObject) {
        const error = new Error("404:tag_not_found");
        error.status = 404;
        throw error;
    }

    const ownerEth = searchResult.tagObject.publicData?.ethAddress;
    if (!verifyAddressSyncOwnership(normalizedTagName, syncPublicData, ownerEth)) {
        const error = new Error("401:invalid_sync_ownership");
        error.status = 401;
        throw error;
    }

    const { updated, rejected } = partitionSyncAddresses(syncPublicData);
    if (!updated.length) {
        throwNoAddressesToSync(rejected);
    }

    return applyAddressSyncToRecord({ tagRecord: searchResult, tagKey, syncPublicData });
};

module.exports = {
    syncAddresses,
};
