const { assertTagAvailable } = require("./tag-availability");
const moment = require("moment");
const TagsPartsModule = require("./tags-parts.module");
const TagsSearchModule = require("./tags-search.module");
const { generateMnemonic } = require("../../Wallet/modules/helpers");
const { createEthWallet } = require("../../Wallet/modules/eth");
const { createSolanaWallet } = require("../../Wallet/modules/solana");
const { createBTCWallet } = require("../../Wallet/modules/btc");
const { generateSuiWalletFromMnemonic } = require("../../Wallet/modules/sui");
const { createStellarWallet } = require("../../Wallet/modules/stellar");
const { createPolkadotWallet, createKusamaWallet } = require("../../Wallet/modules/polkadot-kusama");
const { createTonWallet } = require("../../Wallet/modules/ton");
const { createAptosWallet } = require("../../Wallet/modules/aptos");
const { decrypt, preview, applyPreviewHasPassword, _formattingError, ZELFPROOF_CLIENT_ERROR_STATUS } = require("../../ZelfProof/modules/zelf-proof.module");
const { effectivePassword } = require("../../ZelfID/modules/zelf-id-password.module");
const OfflineProofModule = require("../../../Core/offline-proof");
const config = require("../../../Core/config");
const { confirmPayUniqueAddress } = require("../../purchase-zelf/modules/balance-checker.module");
const { initTagUpdates, tryUpdateTags, tryUpgradeLegacyProofAndRepin } = require("./sync-tag-records.module");
const { resolveEncryptVersion } = require("./tags-addresses.module");

const { generateHoldDomain } = require("./domain-registry.module");
const { getDomainConfig } = require("../config/supported-domains");
const TagsRegistrationModule = require("./tags-registration.module");
const { extractZelfProofFromQR } = require("./qr-zelfproof-extractor.module");
const SessionModule = require("../../Session/modules/session.module");
const QRZelfProofExtractor = require("./qr-zelfproof-extractor.module");
const ArweaveModule = require("../../Arweave/modules/arweave.module");
const { unPinFiles, unpinContinuationSiblings } = require("./tags-ipfs.module");
const jwt = require("jsonwebtoken");

/**
 * Generate domain-specific hold domain
 * @param {string} domain - Domain name
 * @param {string} name - Tag name
 * @returns {string} - Hold domain
 */
const generateDomainHoldDomain = (domain, name) => {
    try {
        return generateHoldDomain(domain, name);
    } catch (error) {
        return generateHoldDomain("zelf", name); // Fallback to zelf
    }
};

/**
 * lease tag
 * @param {Object} params
 * @param {Object} authUser
 */
const leaseTag = async (params, authUser) => {
    const { tagName, domain, referralTagName } = params;
    let securityType = params.securityType;
    const domainConfig = getDomainConfig(domain);

    if (!domainConfig) throw new Error(`Unsupported domain: ${domain}`);

    // Get tag key using the method
    const tagKey = domainConfig.getTagKey() || "tagName";

    await _findDuplicatedTag(tagName, domain, domainConfig);

    const referralTagObject = await _validateReferral(referralTagName, authUser, domainConfig);

    const decryptedParams = await TagsPartsModule.decryptParams(params, authUser);

    const { face, password } = decryptedParams;

    if (!face) throw new Error("409:face_not_found");

    if (!password && securityType !== "withoutPassword") throw new Error("409:password_not_found");

    if (password && !securityType) {
        securityType = /^\d{6}$/.test(password) ? "pin" : "password";
    }

    const { eth, btc, solana, sui, stellar, polkadot, kusama, ton, aptos, zkProof, mnemonic, arweave } = await _createWalletsFromPhrase({
        ...params,
        mnemonic: decryptedParams.mnemonic,
    });

    const dataToEncrypt = {
        publicData: {
            ethAddress: eth.address,
            solanaAddress: solana.address,
            btcAddress: btc.address,
            [tagKey]: tagName,
            domain,
        },
        metadata: {
            mnemonic,
        },
        faceBase64: face,
        _id: tagName,
        tolerance: params.tolerance,
        addServerPassword: Boolean(params.addServerPassword),
    };

    // we won't assign the password if the security type is withoutPassword
    if (securityType !== "withoutPassword") {
        dataToEncrypt.password = password;
    }

    const tagObject = {
        ...dataToEncrypt.publicData,
    };

    TagsPartsModule.assignProperties(
        tagObject,
        dataToEncrypt,
        { eth, btc, solana, sui, stellar, arweave, polkadot, kusama, ton, aptos },
        { ...params, password: dataToEncrypt.password, referralTagObject },
        domainConfig
    );

    await TagsPartsModule.generateZelfProof(dataToEncrypt, tagObject);

    if (tagObject.price === 0) {
        await TagsRegistrationModule.confirmFreeTag(tagObject, referralTagObject, domainConfig, securityType, authUser);
    } else {
        await TagsRegistrationModule.saveHoldTagInIPFS(tagObject, referralTagObject, domainConfig, securityType, authUser);
    }

    if (!tagObject.zelfProof && tagObject.ipfs?.publicData?.zelfProof) {
        tagObject.zelfProof = tagObject.ipfs.publicData.zelfProof;
    }

    if (!tagObject.zelfProof) {
        tagObject.zelfProof = await QRZelfProofExtractor.extractZelfProofFromQR(tagObject.ipfs.url);
    }

    const pgp = await TagsPartsModule.generatePGPKeys(
        dataToEncrypt,
        { eth, btc, solana, sui, stellar, arweave, polkadot, kusama, ton, aptos },
        password
    );

    return {
        ipfs: [tagObject.ipfs],
        available: false,
        name: tagName,
        tagName: `${tagName}.${domain}`,
        domain,
        arweave: tagObject.arweave ? [tagObject.arweave] : [],
        tagObject: {
            ...tagObject.ipfs,
            zelfProof: tagObject.zelfProof,
            zelfProofQRCode: tagObject.zelfProofQRCode,
        },
        walrus: tagObject.walrus,
        pgp,
        metadata:
            config.env === "production"
                ? undefined
                : {
                    // for development porposes so we can visualize the arweave private key and the mnemonic for testing.
                    mnemonic,
                    arweavePrivateKey: arweave.privateKey,
                    stellarSecretKey: stellar.secretKey,
                    substrateSecretKey: polkadot.secretKey,
                },
    };
};

/**
 * search tag
 * @param {Object} params
 * @param {Object} authUser
 */
const searchTag = async (params, authUser) => {
    const { tagName, domain, key, value, environment, type, domainConfig, duration, includeAllAddressPages } = params;

    try {
        const _domainConfig = domainConfig || getDomainConfig(domain);

        const result = await TagsSearchModule.searchTag(
            {
                tagName,
                domain,
                key,
                value,
                environment: environment || "all",
                type: type || "both",
                domainConfig: _domainConfig,
                duration: duration || "1",
                includeAllAddressPages,
            },
            authUser
        );

        if (result.ipfs?.length) {
            for (let index = 0; index < result.ipfs.length; index++) {
                const element = result.ipfs[index];
                delete element.zelfProof;
                delete element.zelfProofQRCode;
            }
        }

        return result;
    } catch (error) {
        console.error({ error });
        throw error;
    }
};


/**
 * Map a ZelfProof/SenseCrypt failure to a thrown Error with distinct HTTP status + code.
 * @param {{ code?: string, message?: string }|string} errPayload
 */
const throwMappedZelfProofError = (errPayload) => {
    const raw = typeof errPayload === "string" ? { code: errPayload, message: errPayload } : errPayload || {};
    const formatted = _formattingError({
        code: raw.code || raw.message,
        message: raw.message || raw.code || "decrypt_failed",
        status: ZELFPROOF_CLIENT_ERROR_STATUS[raw.code],
    });
    const error = new Error(formatted.code || formatted.message || "decrypt_failed");

    error.status = formatted.status || 500;
    error.code = formatted.code || "InternalServerError";

    throw error;
};

/**
 * decrypt tag
 * @param {Object} params
 * @param {Object} authUser
 */
const decryptTag = async (params, authUser) => {
    const { tagName, domain } = params;

    const domainConfig = getDomainConfig(domain);

    const searchResult = await searchTag({ tagName, domain, domainConfig, environment: "all", includeAllAddressPages: true }, authUser);

    if (searchResult.available) return searchResult;

    const tagObject = searchResult.tagObject;

    if (!tagObject?.zelfProof) throw new Error("404:tag_not_found");

    const { face, password: rawPassword } = await _decryptParams(params, authUser);

    // Face-only proofs must be decrypted without a password; clients may still send the placeholder.
    const password = effectivePassword({
        password: rawPassword,
        securityType: params.securityType,
        hasPassword: tagObject.publicData?.hasPassword,
    });

    const decryptedZelfProof = await decrypt({
        addServerPassword: Boolean(params.addServerPassword),
        faceBase64: face,
        password,
        zelfProof: tagObject?.zelfProof,
        hasPassword: tagObject.publicData.hasPassword,
        stack: "v4",
    });

    if (decryptedZelfProof.error) {
        throwMappedZelfProofError(decryptedZelfProof.error);
    }

    const { mnemonic, zkProof, solanaSecretKey } = decryptedZelfProof.metadata;

    const tagKey = domainConfig.getTagKey() || "tagName";

    // Generate Arweave wallet from mnemonic for consistency
    const arweave = await ArweaveModule.generateWalletFromMnemonic(mnemonic);

    // XLM heal + Polkadot/Kusama backfill (publicData + addresses JSON on re-pin) and stellarSecretKey / substrateSecretKey
    // in wallet encrypt live in sync-tag-records.module (initTagUpdates / updateTags).
    const { encryptedMessage, privateKey, tagsToAdd } = await initTagUpdates(tagObject, {
        mnemonic,
        zkProof,
        solanaSecretKey,
        arweavePrivateKey: arweave.privateKey,
        password: password || rawPassword,
    });

    const needsLegacyUpgrade = resolveEncryptVersion(tagObject.publicData) !== 4;

    let upgradedLegacy = false;

    if (needsLegacyUpgrade) {
        const upgraded = await tryUpgradeLegacyProofAndRepin(tagObject, {
            faceBase64: face,
            password,
            addServerPassword: Boolean(params.addServerPassword),
            tagsToAdd,
        });

        if (upgraded.upgraded) {
            tagObject.updatedIpfs = upgraded.ipfs;
            tagObject.updatedArweave = upgraded.arweave;
            upgradedLegacy = true;
        }
    }

    if (!upgradedLegacy && (tagsToAdd.length || tagObject.publicData?._needsPinSplit)) {
        const { ipfs, arweave } = await tryUpdateTags(tagObject, tagsToAdd);

        tagObject.updatedIpfs = ipfs;
        tagObject.updatedArweave = arweave;

        for (let index = 0; index < tagsToAdd.length; index++) {
            const tag = tagsToAdd[index];
            tagObject.publicData[tag.name] = tag.value;
        }
    }

    return {
        ...tagObject,
        domain,
        pgp: { encryptedMessage, privateKey },
        durationToken: jwt.sign(
            {
                tagName: tagObject.publicData[tagKey] || tagObject.publicData.tagName || tagObject.publicData.zelfName,
                exp: moment().add(1, "month").unix(),
            },
            config.JWT_SECRET
        ),
        metadata:
            config.env === "development"
                ? {
                    mnemonic,
                    zkProof,
                    solanaSecretKey,
                    arweavePrivateKey: arweave.privateKey,
                    substrateSecretKey: (await createPolkadotWallet(mnemonic)).secretKey,
                }
                : undefined,
    };
};

/**
 * preview tag
 * @param {Object} params
 * @param {Object} authUser
 */
const previewTag = async (params, authUser) => {
    const domainConfig = getDomainConfig(params.domain);

    const searchResult = await searchTag({ ...params, domainConfig, environment: "all" }, authUser);

    if (searchResult.available) {
        return searchResult;
    }

    const tagObject = searchResult.tagObject;

    const zelfProof = await extractZelfProofFromQR(tagObject.zelfProofQRCode);

    const previewResult = await preview({
        zelfProof,
        addServerPassword: Boolean(params.addServerPassword),
    });

    applyPreviewHasPassword(searchResult.tagObject, previewResult);

    return { preview: previewResult, tagObject: searchResult.tagObject };
};

/**
 * preview ZelfProof
 * @param {Object} params
 * @param {Object} authUser
 */
const previewZelfProof = async (params, authUser) => {
    const { zelfProof } = params;

    const previewResult = await preview({
        zelfProof,
        addServerPassword: Boolean(params.addServerPassword),
    });

    // get any key that has "Name" in the public data
    const tagKey = Object.keys(previewResult.publicData).find((key) => key.includes("Name"));

    const tagName = previewResult.publicData[tagKey];

    const name = tagName?.split(".")[0];

    const domain = tagName?.split(".")[1];

    return {
        preview: previewResult,
        name,
        tagKey,
        tagName,
        domain,
        zelfProof,
    };
};

/**
 * preview ZelfId QR
 * @param {Object} params
 * @param {Object} authUser
 */
const previewZelfIdQr = async (params, authUser) => {
    const { zelfProofQRCode } = params;

    const zelfProof = await extractZelfProofFromQR(zelfProofQRCode);

    if (!zelfProof) throw new Error("409:incorrect_zelf_proof");

    return await previewZelfProof({ ...params, zelfProof }, authUser);
};

/**
 * lease confirmation
 * @param {Object} params
 * @param {Object} authUser
 */
const leaseConfirmation = async (params, authUser) => {
    const { tagName, domain, coin, network } = params;
    const domainConfig = getDomainConfig(domain);

    const confirmation = await confirmPayUniqueAddress({
        tagName: `${tagName}.${domain}`,
        domain,
        domainConfig,
        coin,
        network,
    });

    return {
        tagName: `${tagName}.${domain}`,
        domain,
        domainConfig,
        confirmation,
    };
};

/**
 * Find duplicated tag
 * @param {string} tagName
 * @param {string} domain
 * @param {string} storage
 * @param {Object} domainConfig
 */
const _findDuplicatedTag = async (tagName, domain, domainConfig) => {
    const searchParams = {
        tagName,
        domain,
        domainConfig,
        environment: "all",
    };

    const result = await TagsSearchModule.searchTag(searchParams);

    assertTagAvailable(result);

    return result;
};

/**
 * Find tag
 * @param {Object} params
 * @param {string} storage
 * @param {Object} authUser
 */
const _findTag = async (params, storage, authUser) => {
    const { tagName, domain } = params;
    const domainConfig = getDomainConfig(domain);

    const searchParams = {
        tagName,
        domain,
        domainConfig,
    };

    return await TagsSearchModule.searchTag(searchParams, authUser);
};

/**
 * Validate referral
 * @param {string} referralTagName
 * @param {Object} authUser
 * @param {Domain} domainConfig
 */
const _validateReferral = async (referralTagName, authUser, domainConfig) => {
    if (!referralTagName) return null;

    const domain = domainConfig.name;

    const searchParams = {
        tagName: referralTagName.includes(".") ? referralTagName : `${referralTagName}.${domain}`,
        domain,
        domainConfig,

        environment: "all",
    };

    const result = await TagsSearchModule.searchTag(searchParams, authUser);

    if (result.available === true) return null;

    const tagObject = result.tagObject;

    if (tagObject.publicData.type === "hold") {
        tagObject.publicData[domainConfig.getTagKey()] = tagObject.publicData[domainConfig.getTagKey()].replace(".hold", "");
    }

    return tagObject;
};

/**
 * Create wallets from phrase
 * TODO: Add Arweave wallet generation
 * - Add Arweave public address
 * - Generate private key from mnemonic (12 words)
 * @param {Object} params
 */
const _createWalletsFromPhrase = async (params) => {
    const _mnemonic = params.type === "import" ? params.mnemonic : generateMnemonic(params.wordsCount);

    const wordsArray = _mnemonic.split(" ");

    if (wordsArray.length !== 12 && wordsArray.length !== 24) throw new Error("409:mnemonic_invalid");

    const eth = await createEthWallet(_mnemonic);
    const btc = await createBTCWallet(_mnemonic);
    const solana = await createSolanaWallet(_mnemonic);
    const sui = await generateSuiWalletFromMnemonic(_mnemonic);
    const stellar = createStellarWallet(_mnemonic);
    const polkadot = await createPolkadotWallet(_mnemonic);
    const kusama = await createKusamaWallet(_mnemonic);
    const ton = await createTonWallet(_mnemonic);
    const aptos = await createAptosWallet(_mnemonic);

    const zkProof = await OfflineProofModule.createProof(_mnemonic);
    const arweave = await ArweaveModule.generateWalletFromMnemonic(_mnemonic);

    return {
        eth,
        btc,
        solana,
        sui,
        stellar,
        polkadot,
        kusama,
        ton,
        aptos,
        zkProof,
        mnemonic: _mnemonic,
        arweave,
    };
};

/**
 * Decrypt params
 * @param {Object} params
 * @param {Object} authUser
 */
const _decryptParams = async (params, authUser) => {
    if (params.removePGP) {
        return {
            password: params.password,
            mnemonic: params.mnemonic,
            face: params.faceBase64,
        };
    }

    // Use session decryption for all parameters consistently
    const password = params.password ? await SessionModule.sessionDecrypt(params.password, authUser) : null;
    const mnemonic = params.mnemonic ? await SessionModule.sessionDecrypt(params.mnemonic, authUser) : null;
    const face = params.faceBase64 ? await SessionModule.sessionDecrypt(params.faceBase64, authUser) : null;

    return {
        password,
        mnemonic,
        face,
    };
};

const deleteTag = async (params, authUser) => {
    const { tagName, domain, faceBase64, password } = params;

    const searchResult = await searchTag({ tagName, domain }, authUser);

    const zelfProof = searchResult.tagObject.zelfProof;

    const ipfsID = searchResult.tagObject.id;

    const publicData = searchResult.tagObject.publicData || {};
    const decryptPayload = { faceBase64, password, zelfProof };
    const decryptedZelfProof = await decrypt({ ...decryptPayload, stack: "v4" });

    if (decryptedZelfProof.error) {
        throwMappedZelfProofError(decryptedZelfProof.error);
    }

    const deletedFiles = [];

    if (ipfsID) {
        const canonicalName = publicData.tagName || publicData.zelfName || `${tagName}.${domain}`;
        deletedFiles.push(await unpinContinuationSiblings(canonicalName));
        deletedFiles.push(await unPinFiles([ipfsID]));
    }

    return { tagObject: searchResult.tagObject, deletedFiles };
};

module.exports = {
    leaseTag,
    searchTag,
    decryptTag,
    previewTag,
    previewZelfProof,
    previewZelfIdQr,
    leaseConfirmation,
    deleteTag,
    // Utility functions
    getDomainConfig,
    generateDomainHoldDomain,
    _findDuplicatedTag,
    _validateReferral,
    _createWalletsFromPhrase,
    _decryptParams,
};
