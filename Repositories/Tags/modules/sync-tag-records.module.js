const { createBTCWallet } = require("../../Wallet/modules/btc");
const { healPublicDataXlm } = require("../../Wallet/modules/stellar");
const { generateSuiWalletFromMnemonic } = require("../../Wallet/modules/sui");
const { createTonWallet } = require("../../Wallet/modules/ton");
const { createAptosWallet } = require("../../Wallet/modules/aptos");
const { createPolkadotWallet, createKusamaWallet } = require("../../Wallet/modules/polkadot-kusama");
const SessionModule = require("../../Session/modules/session.module");
const TagsPartsModule = require("./tags-parts.module");
const TagsArweaveModule = require("./tags-arweave.module");
const TagsIPFSModule = require("./tags-ipfs.module");
const moment = require("moment");
const { getDomainConfig } = require("../config/supported-domains");
const { SEARCHABLE_ADDRESS_FIELDS, cleanExtraParamsForPinata, resolveEncryptVersion, stampExtraParamsVersion } = require("./tags-addresses.module");
const { upgrade } = require("../../ZelfProof/modules/zelf-proof.module");
const { generateQRFromZelfProof } = require("./qr-zelfproof-extractor.module");
const { effectivePlan, isUnpaidReservation } = require("../../ZelfID/modules/zelf-id-plan.module");

const ADDRESS_FIELDS_HANDLED_BY_PAGES = new Set(SEARCHABLE_ADDRESS_FIELDS);

/** Overflow fields a v4 lease already writes onto the `_tagName` continuation pin. */
const V4_OVERFLOW_ADDRESS_FIELDS = ["aptosAddress", "dotAddress", "ksmAddress"];

const V4_LEASE_ADDRESS_FIELDS = [
    "ethAddress",
    "solanaAddress",
    "btcAddress",
    "suiAddress",
    "xlmAddress",
    "tonAddress",
    "arweaveAddress",
    "aptosAddress",
    "dotAddress",
    "ksmAddress",
];

const isV4PublicData = (publicData = {}) => Number(publicData.v) === 4;

const isV4LeaseComplete = (publicData = {}) =>
    isV4PublicData(publicData) && V4_LEASE_ADDRESS_FIELDS.every((field) => Boolean(publicData[field]));

const shouldSkipOverflowBackfill = (publicData = {}) => isV4PublicData(publicData);

/**
 * Rebuild Pinata extraParams on decrypt re-pin. Keep st / plan so password type and plan survive.
 * Infer plan for planless mainnet (not `.hold`) via `effectivePlan`.
 * @param {Object} publicData
 * @param {Object} [options]
 * @param {number} [options.encryptVersion]
 * @returns {Object}
 */
const buildRepinExtraParams = (publicData = {}, options = {}) => {
    const version = options.encryptVersion != null ? options.encryptVersion : resolveEncryptVersion(publicData);
    const extraParams = stampExtraParamsVersion(
        {
            hasPassword: publicData.hasPassword,
            origin: publicData.origin || "online",
            registeredAt: publicData.registeredAt
                ? moment(publicData.registeredAt).add(30, "second").format("YYYY-MM-DD HH:mm:ss")
                : undefined,
            expiresAt: publicData.expiresAt
                ? moment(publicData.expiresAt).add(30, "second").format("YYYY-MM-DD HH:mm:ss")
                : undefined,
            price: publicData.price || undefined,
            duration: publicData.duration || undefined,
            type: publicData.type || undefined,
        },
        version
    );

    if (publicData.st && String(publicData.hasPassword) === "true") {
        extraParams.st = publicData.st;
    }

    const plan = publicData.plan || (!isUnpaidReservation(publicData) ? effectivePlan(publicData) : undefined);
    if (plan) {
        extraParams.plan = plan;
    }

    return extraParams;
};

/**
 * Sync Tag Records Module for Tags
 * Placeholder module for tag record synchronization
 */
const initTagUpdates = async (tagObject, secretKeys) => {
    const { mnemonic, zkProof, solanaSecretKey, arweavePrivateKey, password } = secretKeys;

    tagObject.publicData = (await TagsIPFSModule.hydrateContinuationAddresses(tagObject.publicData)) || tagObject.publicData;

    let sui = {};
    let btc = {};

    const tagsToAdd = [];
    const skipAddressBackfill = isV4LeaseComplete(tagObject.publicData);
    const skipOverflow = shouldSkipOverflowBackfill(tagObject.publicData);

    if (!skipAddressBackfill && !tagObject.publicData.suiAddress) {
        sui = await generateSuiWalletFromMnemonic(mnemonic);

        tagObject.publicData.suiAddress = sui.address;

        tagsToAdd.push({ name: "suiAddress", value: sui.address, new: true });
    }

    if (!skipAddressBackfill && !tagObject.publicData.tonAddress) {
        const ton = await createTonWallet(mnemonic);
        tagObject.publicData.tonAddress = ton.address;
        tagsToAdd.push({ name: "tonAddress", value: ton.address, new: true });
    }

    if (!skipAddressBackfill && !skipOverflow && !tagObject.publicData.aptosAddress) {
        const aptos = await createAptosWallet(mnemonic);
        tagObject.publicData.aptosAddress = aptos.address;
        tagsToAdd.push({ name: "aptosAddress", value: aptos.address, new: true });
    }

    if (!skipAddressBackfill && !(tagObject.publicData.btcAddress || "").startsWith("bc1")) {
        btc = createBTCWallet(mnemonic);

        tagObject.publicData.btcAddress = btc.address;

        tagsToAdd.push({ name: "btcAddress", value: btc.address, new: false });
    }

    const { stellar, shouldPersistXlm, hadXlmBeforeHeal } = healPublicDataXlm(tagObject.publicData, mnemonic);

    if (!skipAddressBackfill && shouldPersistXlm) {
        tagsToAdd.push({ name: "xlmAddress", value: tagObject.publicData.xlmAddress, new: !hadXlmBeforeHeal });
    }

    const polkadot = await createPolkadotWallet(mnemonic);
    const kusama = await createKusamaWallet(mnemonic);

    if (!skipAddressBackfill && !skipOverflow && !tagObject.publicData.dotAddress) {
        tagObject.publicData.dotAddress = polkadot.address;
        tagsToAdd.push({ name: "dotAddress", value: polkadot.address, new: true });
    }

    if (!skipAddressBackfill && !skipOverflow && !tagObject.publicData.ksmAddress) {
        tagObject.publicData.ksmAddress = kusama.address;
        tagsToAdd.push({ name: "ksmAddress", value: kusama.address, new: true });
    }

    const domainConfig = getDomainConfig(tagObject.publicData.domain || "zelf");

    const walletScopeKey = TagsPartsModule.getWalletScopeKey(tagObject.publicData, domainConfig);

    const { encryptedMessage, privateKey } = await SessionModule.walletEncrypt(
        {
            mnemonic,
            zkProof,
            solanaSecretKey,
            suiSecretKey: sui.secretKey,
            stellarSecretKey: stellar.secretKey,
            arweavePrivateKey,
            substrateSecretKey: polkadot.secretKey,
        },
        walletScopeKey,
        password,
        tagObject.publicData.ethAddress
    );

    return {
        encryptedMessage,
        privateKey,
        tagsToAdd,
    };
};

const updateTags = async (tagObject, tagsToAdd, options = {}) => {
    const needsPinSplit = Boolean(tagObject.publicData?._needsPinSplit);
    const forceRepin = Boolean(options.forceRepin);
    if ((!tagsToAdd.length && !needsPinSplit && !forceRepin) || !tagObject.zelfProofQRCode) return {};

    const domainConfig = getDomainConfig(tagObject.publicData.domain || "zelf");

    const tagKey = domainConfig.getTagKey();

    const tagName = tagObject.publicData[tagKey];

    const zelfProofQRCode = tagObject.zelfProofQRCode || tagObject.publicData.zelfProofQRCode;

    if (!tagObject.publicData.expiresAt) tagObject.publicData.expiresAt = moment().add(1, "year").format("YYYY-MM-DD HH:mm:ss");

    const extraParams = cleanExtraParamsForPinata(buildRepinExtraParams(tagObject.publicData));

    const metadata = {
        [tagKey]: tagName,
        domain: tagObject.publicData.domain || "zelf",
        extraParams,
        type: tagObject.publicData.type || (tagName.includes("hold") ? "hold" : "mainnet"),
    };

    if (tagObject.publicData.referralTagName) {
        metadata.referral = JSON.stringify({
            tagName: tagObject.publicData.referralTagName,
            solanaAddress: tagObject.publicData.referralSolanaAddress,
        });
        metadata.referralTagName = tagObject.publicData.referralTagName;
    }

    for (let index = 0; index < tagsToAdd.length; index++) {
        const tag = tagsToAdd[index];

        if (ADDRESS_FIELDS_HANDLED_BY_PAGES.has(tag.name)) continue;

        metadata[tag.name] = tag.value;
    }

    metadata.extraParams = JSON.stringify(metadata.extraParams);

    const oldPrimaryId = tagObject.id ? tagObject.ipfsId || tagObject.id : null;
    const oldContinuationIds = await TagsIPFSModule.listContinuationSiblingPinIds(tagName);

    const pinPayload = {
        base64: zelfProofQRCode,
        name: tagName,
        reserved: metadata,
        addresses: tagObject.publicData,
        pinIt: true,
    };

    const ipfs = oldPrimaryId
        ? await TagsIPFSModule.upsertSearchablePins({ ...pinPayload, existingPrimaryPinId: oldPrimaryId }, { pro: true })
        : await TagsIPFSModule.insertSearchablePins(pinPayload, { pro: true });

    let arweave = {};
    if (metadata.type === "mainnet" && domainConfig?.isArweaveEnabled?.()) {
        try {
            arweave = await TagsArweaveModule.tagRegistration(zelfProofQRCode, {
                hasPassword: metadata.hasPassword,
                zelfProof: tagObject.publicData?.zelfProof,
                publicData: { ...metadata },
                fileName: tagName,
            });
        } catch (error) {
            console.error({
                updateTagsArweave: error.code || error.message,
                status: error.status,
            });
        }
    }

    const newContinuationIds = await TagsIPFSModule.listContinuationSiblingPinIds(tagName);
    const keepIds = new Set([ipfs?.id, ...newContinuationIds].filter(Boolean));
    const idsToUnpin = [];

    if (oldPrimaryId && !keepIds.has(oldPrimaryId)) {
        idsToUnpin.push(oldPrimaryId);
    }

    for (const id of oldContinuationIds) {
        if (!keepIds.has(id)) idsToUnpin.push(id);
    }

    if (idsToUnpin.length) {
        await TagsIPFSModule.unPinFiles(idsToUnpin);
    }

    return {
        ipfs,
        arweave,
    };
};

/**
 * Same as {@link updateTags}, but never throws. Decrypt already succeeded.
 *
 * @param {Object} tagObject
 * @param {Array} tagsToAdd
 * @param {Object} [options]
 * @returns {Promise<{ ipfs?: Object, arweave?: Object }>}
 */
const tryUpdateTags = async (tagObject, tagsToAdd, options = {}) => {
    try {
        return await updateTags(tagObject, tagsToAdd, options);
    } catch (error) {
        console.error({
            tryUpdateTags: error.code || error.message,
            status: error.status,
        });
        return {};
    }
};

/**
 * In-process 3.1.6 → v4 upgrade, QR regen, then IPFS re-pin.
 * Does not call HTTP `/api/human-authn/upgrade` (that path is 402).
 *
 * @param {Object} tagObject
 * @param {Object} params
 * @param {string} params.faceBase64
 * @param {string} [params.password]
 * @param {boolean} [params.addServerPassword]
 * @param {Array} [params.tagsToAdd]
 * @returns {Promise<{ upgraded: boolean, ipfs?: Object, arweave?: Object }>}
 */
const upgradeLegacyProofAndRepin = async (tagObject, params = {}) => {
    const zelfProof = tagObject.zelfProof || tagObject.publicData?.zelfProof;
    if (!zelfProof) {
        const error = new Error("404:tag_not_found");
        error.status = 404;
        throw error;
    }

    const upgraded = await upgrade({
        stack: "v4",
        faceBase64: params.faceBase64,
        password: params.password,
        zelfProof,
        addServerPassword: Boolean(params.addServerPassword),
        requireLiveness: false,
    });

    tagObject.zelfProof = upgraded.zelfProof;
    if (tagObject.publicData) tagObject.publicData.zelfProof = upgraded.zelfProof;

    const qr = await generateQRFromZelfProof(upgraded.zelfProof);
    if (!qr || typeof qr !== "string") {
        const error = new Error("zelf_proof_qr_regeneration_failed");
        error.status = 500;
        throw error;
    }
    tagObject.zelfProofQRCode = qr;

    if (!tagObject.publicData) tagObject.publicData = {};
    tagObject.publicData.v = 4;

    const plan = effectivePlan(tagObject.publicData);
    if (plan) {
        tagObject.publicData.plan = plan;
    } else if (isUnpaidReservation(tagObject.publicData)) {
        delete tagObject.publicData.plan;
    }

    const { ipfs, arweave } = await updateTags(tagObject, params.tagsToAdd || [], { forceRepin: true });

    return { upgraded: true, ipfs, arweave };
};

/**
 * Same as {@link upgradeLegacyProofAndRepin}, but never throws.
 * Decrypt already succeeded; a failed 3.1.6 → v4 refresh must not fail the request.
 *
 * @param {Object} tagObject
 * @param {Object} [params]
 * @returns {Promise<{ upgraded: boolean, ipfs?: Object, arweave?: Object }>}
 */
const tryUpgradeLegacyProofAndRepin = async (tagObject, params = {}) => {
    try {
        return await upgradeLegacyProofAndRepin(tagObject, params);
    } catch (error) {
        console.error({
            tryUpgradeLegacyProofAndRepin: error.code || error.message,
            status: error.status,
        });
        return { upgraded: false };
    }
};

module.exports = {
    V4_LEASE_ADDRESS_FIELDS,
    V4_OVERFLOW_ADDRESS_FIELDS,
    buildRepinExtraParams,
    initTagUpdates,
    isV4LeaseComplete,
    updateTags,
    tryUpdateTags,
    upgradeLegacyProofAndRepin,
    tryUpgradeLegacyProofAndRepin,
};
