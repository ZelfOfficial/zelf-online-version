const { getDomainConfig } = require("../config/supported-domains");
const { assertTagAvailable } = require("./tag-availability");
const { _findDuplicatedTag, _validateReferral, previewZelfProof, searchTag } = require("./tags.module");
const TagsPartsModule = require("./tags-parts.module");
const { decrypt } = require("../../ZelfProof/modules/zelf-proof.module");
const { verifyAddressSyncOwnership } = require("./address-sync-ownership.util");
const TagsIPFSModule = require("./tags-ipfs.module");
const TagsArweaveModule = require("./tags-arweave.module");
const TagsRegistrationModule = require("./tags-registration.module");
const { extractZelfProofFromQR, generateQRFromZelfProof } = require("./qr-zelfproof-extractor.module");
const { resolveEncryptVersion, stampExtraParamsVersion } = require("./tags-addresses.module");

const _isV4SenseCryptProof = async (zelfProof) => {
    if (!zelfProof || typeof zelfProof !== "string") return false;

    const ZelfProofModule = require("../../ZelfProof/modules/zelf-proof.module");

    try {
        const preview = await ZelfProofModule.preview({ zelfProof, stack: "v4" });
        return Boolean(preview?.passwordLayer || preview?.publicData || preview?.cleartext_data);
    } catch (_error) {
        return false;
    }
};

const _mapZelfIdOfflineResultToTagsShape = (result) => {
    if (result?.sync) {
        const tagObject = result.tagObject || {};
        return {
            ...tagObject,
            publicData: tagObject.publicData || {},
            updated: result.updated,
            rejected: result.rejected,
        };
    }

    const zelfIDObject = result?.zelfIDObject || {};
    const publicData = zelfIDObject.publicData || {};

    return {
        ...publicData,
        zelfProof: zelfIDObject.zelfProof,
        zelfProofQRCode: zelfIDObject.zelfProofQRCode,
        ipfs: result?.ipfs?.[0] || zelfIDObject,
        arweave: result?.arweave?.[0] || zelfIDObject.arweave,
        origin: publicData.origin || "offline",
        tagName: publicData.tagName || result?.tagName,
    };
};

const _delegateV4LeaseOfflineToZelfId = async (params, authUser) => {
    const { leaseOffline } = require("../../ZelfID/modules/zelf-ids-offline.module");
    const delegated = await leaseOffline(params, authUser);
    return _mapZelfIdOfflineResultToTagsShape(delegated);
};

const _getExtraPublicData = async (password, zelfProof, syncPublicData) => {
    if (!password || !zelfProof || !syncPublicData) {
        return {};
    }

    const extraKeys = {};

    if (syncPublicData.ethAddress) {
        extraKeys.ethAddress = syncPublicData.ethAddress;
    }
    if (syncPublicData.btcAddress) {
        extraKeys.btcAddress = syncPublicData.btcAddress;
    }
    if (syncPublicData.solanaAddress) {
        extraKeys.solanaAddress = syncPublicData.solanaAddress;
    }
    if (syncPublicData.suiAddress) {
        extraKeys.suiAddress = syncPublicData.suiAddress;
    }
    if (syncPublicData.tonAddress) {
        extraKeys.tonAddress = syncPublicData.tonAddress;
    }
    if (syncPublicData.aptosAddress) {
        extraKeys.aptosAddress = syncPublicData.aptosAddress;
    }

    return extraKeys;
};

const _validatePassword = async (zelfProof, password) => {
    const jsonfile = require("../../../config/0012589021.json");

    let isValidPassword = true;

    try {
        await decrypt({
            faceBase64: jsonfile.mFace || jsonfile.faceBase64,
            password,
            os: "DESKTOP",
            zelfProof,
            addServerPassword: false,
        });
    } catch (exception) {
        console.log({ exception });

        isValidPassword = Boolean(exception.message.includes("THE PROVIDED PASSWORD IS INVALID")) ? false : true;
    }

    if (!isValidPassword) {
        const error = new Error("tag_password_invalid");
        error.status = 409;
        throw error;
    }

    return isValidPassword;
};

const _syncOfflineTag = async (tagRecord, tagKey, syncPublicData, sync, password, signedOwnership = false) => {
    const tagObject = tagRecord.tagObject;

    const ipfsRecord = tagRecord.ipfs?.length ? tagRecord.ipfs[0] : null;

    const ipfsHash = ipfsRecord?.ipfs_pin_hash || ipfsRecord?.ipfsHash || ipfsRecord?.cid;

    const arweaveHash = tagRecord.arweave?.length ? tagRecord.arweave[0].arweave_pin_hash || tagRecord.arweave[0].arweaveHash : null;

    if (tagObject && (!sync || !syncPublicData || (!password && !signedOwnership))) {
        const error = new Error(`tag_purchased_already:${tagObject.publicData[tagKey]}`);

        error.status = 409;

        throw error;
    }

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

    // keys to updte goes here
    // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

    const addressSource = {
        ...tagObject.publicData,
        suiAddress: syncPublicData.suiAddress || tagObject.publicData.suiAddress,
        xlmAddress: syncPublicData.stellarAddress || syncPublicData.xlmAddress || tagObject.publicData.xlmAddress,
        btcAddress: syncPublicData.btcAddress || syncPublicData.bitcoinAddress || tagObject.publicData.btcAddress,
        dotAddress: syncPublicData.dotAddress || syncPublicData.polkadotAddress || tagObject.publicData.dotAddress,
        ksmAddress: syncPublicData.ksmAddress || syncPublicData.kusamaAddress || tagObject.publicData.ksmAddress,
        tonAddress: tagObject.publicData.tonAddress || syncPublicData.tonAddress,
        aptosAddress: syncPublicData.aptosAddress || tagObject.publicData.aptosAddress,
    };

    // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

    metadata.extraParams = JSON.stringify(metadata.extraParams);

    const ipfs = await TagsIPFSModule.insertSearchablePins(
        {
            base64: tagObject.zelfProofQRCode,
            name: tagObject.publicData[tagKey],
            reserved: metadata,
            addresses: addressSource,
            pinIt: true,
        },
        { pro: true }
    );

    if (ipfsHash && ipfsRecord.id && ipfsRecord.id !== ipfs?.id) {
        await TagsIPFSModule.deleteFiles([ipfsRecord.id]);
    }

    let arweave = null;

    if (metadata.type === "mainnet") {
        // save in Arweave as well
        arweave = await TagsArweaveModule.tagRegistration(tagObject.zelfProofQRCode, {
            hasPassword: metadata.hasPassword,
            zelfProof: metadata.zelfProof,
            publicData: { ...tagObject.publicData, ...addressSource, ...metadata },
        });
    }

    const updatedTagObject = {
        ...tagObject,
        publicData: { ...tagObject.publicData, ...addressSource },
        ipfs,
        arweave,
        origin: "offline",
        tagName: tagObject.publicData[tagKey],
    };

    return updatedTagObject;
};

/**
 * lease offline tag
 * @param {Object} params
 * @param {Object} authUser
 */
const leaseOfflineTag = async (params, authUser) => {
    const { tagName, domain, referralTagName, sync, syncPassword, syncPublicData, duration } = params;

    let zelfProofQRCode = params.zelfProofQRCode;
    let zelfProof = params.zelfProof;

    const domainConfig = getDomainConfig(domain);

    const tagKey = domainConfig.getTagKey();

    sync ? "do nothing" : await _findDuplicatedTag(tagName, domain, domainConfig);

    const referralTagObject = await _validateReferral(referralTagName, authUser, domainConfig);

    const decryptedParams = await TagsPartsModule.decryptParams({ password: syncPassword, removePGP: params.removePGP }, authUser);

    const { password } = decryptedParams;

    if (!zelfProof) {
        zelfProof = await extractZelfProofFromQR(zelfProofQRCode);
    }

    if (!zelfProof || typeof zelfProof !== "string") throw new Error("400:missing_or_invalid_zelf_proof");

    if (!zelfProofQRCode) {
        zelfProofQRCode = await generateQRFromZelfProof(zelfProof);
    }

    if (await _isV4SenseCryptProof(zelfProof)) {
        return await _delegateV4LeaseOfflineToZelfId(
            {
                ...params,
                tagName,
                domain,
                zelfProof,
                zelfProofQRCode,
                password: password || syncPassword,
                syncPassword,
            },
            authUser
        );
    }

    const { preview } = await previewZelfProof({ zelfProof }, authUser);

    const _normalizeTagName = (name, _domain) => {
        if (!name) return name;
        return name.includes(".") ? name : `${name}.${_domain}`;
    };

    const resolvedDomain = preview.publicData.domain || domain;

    const tagNameFromProof = TagsPartsModule.getTagNameFromPublicData({ publicData: preview.publicData }, "full", domainConfig);

    if (!tagNameFromProof) {
        console.log("Could not resolve tag name from zelfProof publicData", preview.publicData);
        throw new Error("tag_not_found_in_zelfProof");
    }

    const normalizedProofTagName = _normalizeTagName(tagNameFromProof, resolvedDomain);
    const normalizedTagName = _normalizeTagName(tagName, resolvedDomain);

    if (normalizedProofTagName !== normalizedTagName) {
        throw new Error("tag_does_not_match_in_zelfProof");
    }

    const findExistingTag = await searchTag({ tagName: normalizedProofTagName, domain, domainConfig, environment: "all", includeAllAddressPages: true }, authUser);

    const extraPublicData = await _getExtraPublicData(password, zelfProof, syncPublicData);

    if (sync && findExistingTag?.tagObject) {
        const hasSignature = Boolean(syncPublicData?._syncSignature);
        const signedOwnership = hasSignature && verifyAddressSyncOwnership(
            normalizedProofTagName, syncPublicData, findExistingTag.tagObject.publicData?.ethAddress
        );
        if (hasSignature && !signedOwnership) throw new Error("401:invalid_sync_ownership");
        if (!signedOwnership) await _validatePassword(zelfProof, password);

        return await _syncOfflineTag(findExistingTag, tagKey, syncPublicData, sync, password, signedOwnership);
    }

    if (findExistingTag.tagObject) throw new Error("tag_purchased_already");

    assertTagAvailable(findExistingTag);

    const { price, reward, discount, discountType } = domainConfig.getPrice(
        tagName,
        duration,
        referralTagObject?.publicData?.[tagKey] ? `${referralTagObject.publicData?.[tagKey]}` : ""
    );

    const tagObject = {
        ...preview.publicData,
        hasPassword: preview.passwordLayer === "WithPassword" ? "true" : "false",
        duration,
        zelfProof,
        zelfProofQRCode,
        price,
        reward,
        discount,
        discountType,
        origin: "offline",
        tagName,
    };

    if (extraPublicData?.suiAddress) {
        tagObject.suiAddress = extraPublicData.suiAddress;
    }
    if (extraPublicData?.ethAddress) {
        tagObject.ethAddress = extraPublicData.ethAddress;
    }
    if (extraPublicData?.btcAddress) {
        tagObject.btcAddress = extraPublicData.btcAddress;
    }
    if (extraPublicData?.solanaAddress) {
        tagObject.solanaAddress = extraPublicData.solanaAddress;
    }
    if (extraPublicData?.aptosAddress) {
        tagObject.aptosAddress = extraPublicData.aptosAddress;
    }

    const securityType = password ? (/^\d{6}$/.test(password) ? "pin" : "password") : null;

    if (price === 0) {
        await TagsRegistrationModule.confirmFreeTag(tagObject, referralTagObject, domainConfig, securityType, authUser);
    } else {
        await TagsRegistrationModule.saveHoldTagInIPFS(tagObject, referralTagObject, domainConfig, securityType, authUser);
    }

    return tagObject;
};

module.exports = {
    leaseOfflineTag,
};
