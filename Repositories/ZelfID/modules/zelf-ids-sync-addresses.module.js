/**
 * POST `/api/zelf-ids/sync-addresses` — publish wallet-derived addresses without decrypting the Zelf proof.
 */
const { getDomainConfig } = require("../../Tags/config/supported-domains");
const { verifyAddressSyncOwnership } = require("../../Tags/modules/address-sync-ownership.util");
const { syncOfflineTagAddresses } = require("../../Tags/modules/tags-offline.module");
const { validateNetworkAddress } = require("../../TxNotifications/modules/address-validation.util");
const ZelfIdModule = require("./zelf-id.module");

const SYNC_FIELD_TO_NETWORK = {
    bitcoinAddress: "bitcoin",
    btcAddress: "bitcoin",
    suiAddress: "sui",
    stellarAddress: "stellar",
    xlmAddress: "stellar",
    kusamaAddress: "kusama",
    ksmAddress: "kusama",
    polkadotAddress: "polkadot",
    dotAddress: "polkadot",
    tonAddress: "ton",
    aptosAddress: "aptos",
};

const normalizeTagName = (tagName, domain) => {
    const trimmed = String(tagName || "").trim().toLowerCase();
    if (!trimmed) return trimmed;
    return trimmed.includes(".") ? trimmed : `${trimmed}.${String(domain || "zelf").toLowerCase()}`;
};

const listSyncAddressKeys = (syncPublicData = {}) =>
    Object.keys(syncPublicData).filter((key) => !key.startsWith("_") && syncPublicData[key]);

const partitionSyncAddresses = (syncPublicData = {}) => {
    const updated = [];
    const rejected = {};
    const accepted = {
        _syncSignature: syncPublicData._syncSignature,
        _syncIssuedAt: syncPublicData._syncIssuedAt,
    };

    for (const key of listSyncAddressKeys(syncPublicData)) {
        const network = SYNC_FIELD_TO_NETWORK[key];
        if (!network) {
            rejected[key] = "unsupported_field";
            continue;
        }

        const validation = validateNetworkAddress(network, syncPublicData[key]);
        if (!validation) {
            rejected[network] = "invalid_address";
            continue;
        }

        accepted[key] = syncPublicData[key];
        if (!updated.includes(network)) {
            updated.push(network);
        }
    }

    return { updated, rejected, accepted };
};

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
        const error = new Error("409:no_addresses_to_sync");
        error.status = 409;
        throw error;
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

    const { updated, rejected, accepted } = partitionSyncAddresses(syncPublicData);

    if (!updated.length) {
        return { updated: [], rejected };
    }

    await syncOfflineTagAddresses(searchResult, tagKey, accepted);

    return { updated, rejected };
};

module.exports = {
    syncAddresses,
    partitionSyncAddresses,
    listSyncAddressKeys,
    SYNC_FIELD_TO_NETWORK,
};
