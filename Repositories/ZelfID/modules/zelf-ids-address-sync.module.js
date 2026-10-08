/**
 * Shared v4 address sync for `/api/zelf-ids/sync-addresses` and `/api/zelf-ids/lease-offline` (`sync: true`).
 * Ports Tags `_syncOfflineTag` repin logic without importing Tags offline/registration modules.
 */
const TagsIPFSModule = require("../../Tags/modules/tags-ipfs.module");
const TagsArweaveModule = require("../../Tags/modules/tags-arweave.module");
const { getDomainConfig } = require("../../Tags/config/supported-domains");
const { verifyAddressSyncOwnership } = require("../../Tags/modules/address-sync-ownership.util");
const {
    resolveEncryptVersion,
    stampExtraParamsVersion,
    mergeAddressKeyvaluesIntoPublicData,
    expandPackedAddresses,
} = require("../../Tags/modules/tags-addresses.module");
const { validateNetworkAddress } = require("../../TxNotifications/modules/address-validation.util");
const HumanAuthnModule = require("../../HumanAuthn/modules/human-authn.module");
const ZelfIdPartsModule = require("./zelf-id-parts.module");

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

const CANONICAL_FIELD_ALIASES = {
    btcAddress: ["btcAddress", "bitcoinAddress"],
    xlmAddress: ["stellarAddress", "xlmAddress"],
    dotAddress: ["polkadotAddress", "dotAddress"],
    ksmAddress: ["kusamaAddress", "ksmAddress"],
    suiAddress: ["suiAddress"],
    tonAddress: ["tonAddress"],
    aptosAddress: ["aptosAddress"],
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

const readAcceptedValue = (accepted, canonicalKey) => {
    const aliases = CANONICAL_FIELD_ALIASES[canonicalKey] || [canonicalKey];
    for (const alias of aliases) {
        if (accepted[alias]) return accepted[alias];
    }
    return undefined;
};

/**
 * Merge validated sync fields onto existing publicData. Sync values win (including TON).
 * @param {Object} publicData
 * @param {Object} accepted - Output of `partitionSyncAddresses`
 * @returns {Object}
 */
const buildAddressSourceFromSync = (publicData, accepted) => {
    const next = { ...publicData };

    const apply = (canonicalKey) => {
        const value = readAcceptedValue(accepted, canonicalKey);
        if (value) {
            next[canonicalKey] = value;
        }
    };

    apply("suiAddress");
    apply("xlmAddress");
    apply("btcAddress");
    apply("dotAddress");
    apply("ksmAddress");
    apply("tonAddress");
    apply("aptosAddress");

    return next;
};

const PERSISTED_ADDRESS_FIELDS = [
    "suiAddress",
    "xlmAddress",
    "btcAddress",
    "dotAddress",
    "ksmAddress",
    "tonAddress",
    "aptosAddress",
];

const addressFieldsChanged = (before, after) =>
    PERSISTED_ADDRESS_FIELDS.some((field) => (before[field] || "") !== (after[field] || ""));

const resolveCanonicalAddressField = (syncKey) => {
    if (syncKey === "bitcoinAddress") return "btcAddress";
    if (syncKey === "stellarAddress" || syncKey === "xlmAddress") return "xlmAddress";
    if (syncKey === "polkadotAddress" || syncKey === "dotAddress") return "dotAddress";
    if (syncKey === "kusamaAddress" || syncKey === "ksmAddress") return "ksmAddress";
    return syncKey;
};

/**
 * Networks whose canonical address field actually changed on the persisted pin (post re-read).
 * @param {Object} beforePublicData
 * @param {Object} afterPublicData
 * @param {Object} accepted
 * @returns {string[]}
 */
const expandPersistedAddressView = (publicData = {}) => {
    const view = { ...publicData };
    mergeAddressKeyvaluesIntoPublicData(view);
    expandPackedAddresses(view);
    return view;
};

const computePersistedUpdatedNetworks = (beforePublicData, afterPublicData, accepted) => {
    const before = expandPersistedAddressView(beforePublicData);
    const after = expandPersistedAddressView(afterPublicData);
    const updated = [];

    for (const key of listSyncAddressKeys(accepted)) {
        const network = SYNC_FIELD_TO_NETWORK[key];
        if (!network) continue;

        const canonical = resolveCanonicalAddressField(key);
        const afterVal = after[canonical];
        const beforeVal = before[canonical];

        if (afterVal && afterVal !== (beforeVal || "")) {
            if (!updated.includes(network)) updated.push(network);
        }
    }

    return updated;
};

const throwNoAddressesToSync = (rejected = {}) => {
    const error = new Error("409:no_addresses_to_sync");
    error.status = 409;
    error.rejected = rejected;
    throw error;
};

/**
 * Repin IPFS (and Arweave on mainnet) with merged addresses.
 * @param {Object} tagRecord
 * @param {string} tagKey
 * @param {Object} addressSource
 * @returns {Promise<Object>}
 */
const mapArweaveSyncFailure = (error) => {
    const status = error?.status || error?.response?.status || error?.statusCode;
    const message = String(error?.message || error || "");
    if (status === 402 || message.includes("402") || /payment required/i.test(message)) {
        const err = new Error("402:arweave_payment_required");
        err.status = 402;
        throw err;
    }
};

const repinOfflineAddressSync = async (tagRecord, tagKey, addressSource, options = {}) => {
    const tagObject = tagRecord.tagObject;
    const ipfsRecord = tagRecord.ipfs?.length ? tagRecord.ipfs[0] : null;
    const ipfsHash = ipfsRecord?.ipfs_pin_hash || ipfsRecord?.ipfsHash || ipfsRecord?.cid;
    const zelfProofQRCode = options.zelfProofQRCode || tagObject.zelfProofQRCode;
    const domain = tagObject.publicData?.domain || options.domain || "zelf";
    const domainConfig = getDomainConfig(domain);

    const extraParams = stampExtraParamsVersion(
        {
            origin: tagObject.publicData.origin || "online",
            registeredAt: tagObject.publicData.registeredAt,
            expiresAt: tagObject.publicData.expiresAt,
            price: tagObject.publicData.price ?? undefined,
            plan: tagObject.publicData.plan,
            st: tagObject.publicData.st,
            duration: tagObject.publicData.duration || undefined,
            hasPassword: tagObject.publicData.hasPassword || undefined,
            referralTagName: tagObject.publicData.referralTagName || undefined,
            referralSolanaAddress: tagObject.publicData.referralSolanaAddress || undefined,
        },
        resolveEncryptVersion(tagObject.publicData)
    );

    const metadata = {
        [tagKey]: tagObject.publicData[tagKey],
        hasPassword: tagObject.publicData.hasPassword || "false",
        extraParams,
        type: tagObject.publicData.type || "hold",
        domain: tagObject.publicData.domain || undefined,
    };

    metadata.extraParams = JSON.stringify(metadata.extraParams);

    const ipfs = await TagsIPFSModule.upsertSearchablePins(
        {
            base64: zelfProofQRCode,
            name: tagObject.publicData[tagKey],
            reserved: metadata,
            addresses: addressSource,
            pinIt: true,
            existingPrimaryPinId: ipfsRecord?.id,
        },
        { pro: true }
    );

    if (ipfsHash && ipfsRecord?.id && ipfsRecord.id !== ipfs?.id) {
        await TagsIPFSModule.deleteFiles([ipfsRecord.id]);
    }

    let arweave = tagObject.arweave || null;

    if (metadata.type === "mainnet" && domainConfig?.isArweaveEnabled?.()) {
        try {
            arweave = await TagsArweaveModule.tagRegistration(zelfProofQRCode, {
                hasPassword: metadata.hasPassword,
                zelfProof: tagObject.zelfProof || tagObject.publicData?.zelfProof,
                publicData: { ...tagObject.publicData, ...addressSource, ...metadata },
            });
        } catch (error) {
            mapArweaveSyncFailure(error);
            console.error({ addressSyncArweave: error?.message || error });
        }
    }

    const persistedPublic = ipfs?.publicData ? { ...ipfs.publicData } : { ...tagObject.publicData, ...addressSource };

    return {
        ...tagObject,
        publicData: persistedPublic,
        ipfs,
        arweave,
        origin: "offline",
        tagName: tagObject.publicData[tagKey],
    };
};

const validateSyncPassword = async (zelfProof, params, authUser) => {
    try {
        const { face, password } = await ZelfIdPartsModule.decryptParams(params, authUser);
        if (!password) return false;

        const decrypted = await HumanAuthnModule.decrypt({
            faceBase64: face,
            password,
            zelfProof,
            addServerPassword: false,
            os: params.os || "DESKTOP",
        });

        if (decrypted?.error) {
            const code = String(decrypted.error.code || decrypted.error.message || "");
            if (code.toLowerCase().includes("password")) return false;
            return false;
        }

        return Boolean(decrypted?.metadata || decrypted?.cleartext_data || decrypted?.zelfProof);
    } catch (exception) {
        const message = String(exception?.message || exception);
        if (message.toLowerCase().includes("password")) return false;
        return false;
    }
};

/**
 * Apply validated address sync to an existing search record.
 * @param {Object} params
 * @param {Object} params.tagRecord
 * @param {string} params.tagKey
 * @param {Object} params.syncPublicData
 * @returns {Promise<{ updated: string[], rejected: Record<string, string> }>}
 */
const applyAddressSyncToRecord = async ({ tagRecord, tagKey, syncPublicData, zelfProofQRCode, domain }) => {
    if (!listSyncAddressKeys(syncPublicData).length) {
        throwNoAddressesToSync();
    }

    const { rejected, accepted } = partitionSyncAddresses(syncPublicData);
    const beforePublicData = { ...tagRecord.tagObject.publicData };
    const addressSource = buildAddressSourceFromSync(beforePublicData, accepted);

    const tagObject = await repinOfflineAddressSync(tagRecord, tagKey, addressSource, {
        zelfProofQRCode,
        domain,
    });

    const afterPublicData = tagObject.ipfs?.publicData || tagObject.publicData || {};
    const updated = computePersistedUpdatedNetworks(beforePublicData, afterPublicData, accepted);

    if (!updated.length) {
        throwNoAddressesToSync(rejected);
    }

    return { updated, rejected, tagObject };
};

module.exports = {
    SYNC_FIELD_TO_NETWORK,
    normalizeTagName,
    listSyncAddressKeys,
    partitionSyncAddresses,
    buildAddressSourceFromSync,
    addressFieldsChanged,
    computePersistedUpdatedNetworks,
    repinOfflineAddressSync,
    applyAddressSyncToRecord,
    verifyAddressSyncOwnership,
    validateSyncPassword,
    throwNoAddressesToSync,
};
