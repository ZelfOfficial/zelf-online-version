const { assertTagAvailable } = require("../../Tags/modules/tag-availability");
/**
 * ZelfID online product module (`/api/zelf-ids`). Encrypt/decrypt/preview always use ZelfEncrypt v4.
 * Field names stay `tagName` / `tagObject` for client compatibility with `/api/tags`.
 */
const moment = require("moment");
const ZelfIdPartsModule = require("./zelf-id-parts.module");
const TagsSearchModule = require("../../Tags/modules/tags-search.module");
const { generateMnemonic } = require("../../Wallet/modules/helpers");
const { createEthWallet } = require("../../Wallet/modules/eth");
const { createSolanaWallet } = require("../../Wallet/modules/solana");
const { createBTCWallet } = require("../../Wallet/modules/btc");
const { generateSuiWalletFromMnemonic } = require("../../Wallet/modules/sui");
const { createStellarWallet } = require("../../Wallet/modules/stellar");
const { createPolkadotWallet, createKusamaWallet } = require("../../Wallet/modules/polkadot-kusama");
const { createTonWallet } = require("../../Wallet/modules/ton");
const { createAptosWallet } = require("../../Wallet/modules/aptos");
const { decrypt, preview, previewWithLegacyFallback, applyPreviewHasPassword } = require("../../ZelfProof/modules/zelf-proof.module");
const OfflineProofModule = require("../../../Core/offline-proof");
const config = require("../../../Core/config");
const { confirmPayUniqueAddress } = require("../../purchase-zelf/modules/balance-checker.module");
const { initTagUpdates, tryUpdateTags, tryUpgradeLegacyProofAndRepin } = require("../../Tags/modules/sync-tag-records.module");
const { resolveEncryptVersion } = require("../../Tags/modules/tags-addresses.module");

const { generateHoldDomain } = require("../../Tags/modules/domain-registry.module");
const { getDomainConfig } = require("../../Tags/config/supported-domains");
const ZelfIdsRegistrationModule = require("./zelf-ids-registration.module");
const { extractZelfProofFromQR } = require("../../Tags/modules/qr-zelfproof-extractor.module");
const SessionModule = require("../../Session/modules/session.module");
const QRZelfProofExtractor = require("../../Tags/modules/qr-zelfproof-extractor.module");
const ArweaveModule = require("../../Arweave/modules/arweave.module");
const { unPinFiles, unpinContinuationSiblings } = require("../../Tags/modules/tags-ipfs.module");
const jwt = require("jsonwebtoken");
const {
    resolveZelfIdPlan,
    resolveComplimentaryPlan,
    isUnpaidExpiredReservation,
    effectivePlan,
    getZelfIdPrice,
    getZelfIdCheckoutPrice,
} = require("./zelf-id-plan.module");

/**
 * Force the shared ZelfProof client onto `/zelf-v4`.
 * @param {Object} data
 * @returns {Object}
 */
const withV4 = (data) => ({ ...data, stack: "v4" });

/**
 * Add `origin: "online"` and short `v: 4` to encrypt cleartext.
 * @param {Object} publicData
 * @returns {Object}
 */
const stampV4PublicData = (publicData) => ({
    ...publicData,
    origin: "online",
    v: "4",
});

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
        return generateHoldDomain("zelf", name);
    }
};

/**
 * Lease (create/import) a Zelf ID. Always ZelfEncrypt v4.
 *
 * Inbound after Joi + domain extract: `tagName`, `domain`, `faceBase64`, `type` (`create`|`import`),
 * `os` (`DESKTOP`|`ANDROID`|`IOS`) required. Optional: `password`, `mnemonic` (import), `tolerance`,
 * `addServerPassword`, `securityType`, `referralTagName`, `removePGP`, `captchaToken`, `wordsCount`.
 * Face/password/mnemonic are session-decrypted unless `removePGP` is true.
 *
 * @param {Object} params
 * @param {Object} authUser JWT session user
 * @returns {Promise<Object>} `{ ipfs, tagName, domain, tagObject, pgp, ... }`
 */
const leaseTag = async (params, authUser) => {
    const { tagName, domain, referralTagName } = params;
    let securityType = params.securityType;
    const domainConfig = getDomainConfig(domain);

    if (!domainConfig) throw new Error(`Unsupported domain: ${domain}`);

    const tagKey = domainConfig.getTagKey() || "tagName";

    await _findDuplicatedTag(tagName, domain, domainConfig);

    const referralTagObject = await _validateReferral(referralTagName, authUser, domainConfig);

    const decryptedParams = await ZelfIdPartsModule.decryptParams(params, authUser);

    const { face, password } = decryptedParams;

    if (!face) throw new Error("409:face_not_found");

    if (!password && securityType !== "withoutPassword") throw new Error("409:password_not_found");

    if (password && !securityType) {
        securityType = /^\d{6}$/.test(password) ? "pin" : "password";
    }

    const proofSecurityType =
        securityType === "pin" ? "pin" : securityType === "password" || securityType === "securePassword" ? "password" : "";

    const { eth, btc, solana, sui, stellar, polkadot, kusama, ton, aptos, zkProof, mnemonic, arweave } = await _createWalletsFromPhrase({
        ...params,
        mnemonic: decryptedParams.mnemonic,
    });

    const dataToEncrypt = {
        publicData: stampV4PublicData({
            ethAddress: eth.address,
            solanaAddress: solana.address,
            btcAddress: btc.address,
            [tagKey]: tagName,
            domain,
            ...(proofSecurityType ? { st: proofSecurityType } : {}),
        }),
        metadata: {
            mnemonic,
        },
        faceBase64: face,
        _id: tagName,
        tolerance: params.tolerance,
        addServerPassword: Boolean(params.addServerPassword),
    };

    if (securityType !== "withoutPassword") {
        dataToEncrypt.password = password;
    }

    const tagObject = {
        ...dataToEncrypt.publicData,
        origin: "online",
        v: "4",
    };

    ZelfIdPartsModule.assignProperties(
        tagObject,
        dataToEncrypt,
        { eth, btc, solana, sui, stellar, arweave, polkadot, kusama, ton, aptos },
        { ...params, password: dataToEncrypt.password, referralTagObject },
        domainConfig
    );

    await ZelfIdPartsModule.generateZelfProof(dataToEncrypt, tagObject);

    await persistZelfIdLease(tagObject, referralTagObject, domainConfig, securityType, authUser);

    if (!tagObject.zelfProof && tagObject.ipfs?.publicData?.zelfProof) {
        tagObject.zelfProof = tagObject.ipfs.publicData.zelfProof;
    }

    if (!tagObject.zelfProof) {
        tagObject.zelfProof = await QRZelfProofExtractor.extractZelfProofFromQR(tagObject.ipfs.url);
    }

    const pgp = await ZelfIdPartsModule.generatePGPKeys(
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
                    mnemonic,
                    arweavePrivateKey: arweave.privateKey,
                    stellarSecretKey: stellar.secretKey,
                    substrateSecretKey: polkadot.secretKey,
                },
    };
};

/**
 * Search the same IPFS/Arweave index as Tags (no encrypt).
 * Inbound query: `tagName`, `domain` required (Joi); optional `key`, `value`, `os`, `duration`,
 * `environment` (`ipfs`|`arweave`|`walrus`|`all`), `type` (`both`|`mainnet`|`hold`).
 *
 * @param {Object} params
 * @param {Object} [authUser]
 * @returns {Promise<Object>} search result (`available`, `tagName`, `tagObject?`, `price?`)
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

        const released = applyExpiredPlanDowngrade(
            attachAvailableZelfIdPricing(
                await releaseExpiredUnpaidReservation(result, {
                    tagName,
                    domain,
                    domainConfig: _domainConfig,
                    duration: duration || "1",
                }),
                {
                    tagName,
                    duration: duration || "1",
                    domainConfig: _domainConfig,
                }
            )
        );

        if (released.ipfs?.length) {
            for (let index = 0; index < released.ipfs.length; index++) {
                const element = released.ipfs[index];
                delete element.zelfProof;
                delete element.zelfProofQRCode;
            }
        }

        return released;
    } catch (error) {
        console.error({ error });
        throw error;
    }
};

/**
 * Decrypt a stored Zelf ID via v4 (looks up `zelfProof` from search, then decrypt).
 * Inbound: `tagName`, `domain`, `faceBase64`, `os` required; `password`, `addServerPassword`, `removePGP` optional.
 *
 * @param {Object} params
 * @param {Object} authUser
 * @returns {Promise<Object>} tag object plus `pgp`, `durationToken`, optional `metadata` in development
 */
const decryptTag = async (params, authUser) => {
    const { tagName, domain } = params;

    const domainConfig = getDomainConfig(domain);

    const searchResult = await searchTag({ tagName, domain, domainConfig, environment: "all", includeAllAddressPages: true }, authUser);

    if (searchResult.available) return searchResult;

    const tagObject = searchResult.tagObject;

    if (!tagObject?.zelfProof) throw new Error("404:tag_not_found");

    const { face, password } = await _decryptParams(params, authUser);

    const decryptPayload = {
        addServerPassword: Boolean(params.addServerPassword),
        faceBase64: face,
        password,
        zelfProof: tagObject?.zelfProof,
        hasPassword: tagObject.publicData.hasPassword,
    };

    let needsLegacyUpgrade = resolveEncryptVersion(tagObject.publicData) !== 4;
    const decryptedZelfProof = await decrypt(withV4(decryptPayload));

    if (decryptedZelfProof.error) {
        const error = new Error(decryptedZelfProof.error.code);

        error.status = 409;

        throw error;
    }

    const { mnemonic, zkProof, solanaSecretKey } = decryptedZelfProof.metadata;

    const tagKey = domainConfig.getTagKey() || "tagName";

    const arweave = await ArweaveModule.generateWalletFromMnemonic(mnemonic);

    const { encryptedMessage, privateKey, tagsToAdd } = await initTagUpdates(tagObject, {
        mnemonic,
        zkProof,
        solanaSecretKey,
        arweavePrivateKey: arweave.privateKey,
        password,
    });

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
        const { ipfs, arweave: updatedArweave } = await tryUpdateTags(tagObject, tagsToAdd);

        tagObject.updatedIpfs = ipfs;
        tagObject.updatedArweave = updatedArweave;

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
 * Preview a name: if taken, v4-preview the stored proof; if available, return pricing.
 * Inbound query/body: `tagName`, `domain`, `os` required; `addServerPassword` optional.
 *
 * @param {Object} params
 * @param {Object} authUser
 * @returns {Promise<Object>} `{ preview, tagObject }` or availability/price payload
 */
const previewTag = async (params, authUser) => {
    const domainConfig = params.domainConfig || getDomainConfig(params.domain);

    const searchResult = await searchTag({ ...params, domainConfig, environment: "all" }, authUser);

    if (searchResult.available) {
        return searchResult;
    }

    const tagObject = searchResult.tagObject;

    const zelfProof = await extractZelfProofFromQR(tagObject.zelfProofQRCode);

    const previewResult = await previewWithLegacyFallback({
        zelfProof,
        addServerPassword: Boolean(params.addServerPassword),
    });

    applyPreviewHasPassword(searchResult.tagObject, previewResult);

    return { preview: previewResult, tagObject: searchResult.tagObject };
};

/**
 * Preview a raw proof string on v4 (no name lookup).
 * Inbound: `zelfProof`, `os` required; `addServerPassword` optional.
 *
 * @param {Object} params
 * @returns {Promise<Object>} `{ preview, name, tagKey, tagName, domain, zelfProof }`
 */
const previewZelfProof = async (params) => {
    const { zelfProof } = params;

    const previewResult = await preview(
        withV4({
            zelfProof,
            addServerPassword: Boolean(params.addServerPassword),
        })
    );

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
 * Extract proof from a QR image, then {@link previewZelfProof}.
 * Inbound: `zelfProofQRCode`, `os` required.
 *
 * @param {Object} params
 * @param {Object} authUser
 * @returns {Promise<Object>}
 */
const previewZelfIdQr = async (params, authUser) => {
    const { zelfProofQRCode } = params;

    const zelfProof = await extractZelfProofFromQR(zelfProofQRCode);

    if (!zelfProof) throw new Error("409:incorrect_zelf_proof");

    return await previewZelfProof({ ...params, zelfProof }, authUser);
};

/**
 * Confirm payment for a hold name.
 * Inbound: `tagName`, `domain`, `coin`, `network` (`ETH`|`SOL`|`BTC`).
 *
 * @param {Object} params
 * @returns {Promise<Object>}
 */
const leaseConfirmation = async (params) => {
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
 * Persist a Zelf ID lease: 1–27 characters confirm as `free` mainnet (`name.zelf`, 100-year sentinel).
 * Upgrade pricing stays on the license quote for search/checkout; lease pins are always free.
 * @param {Object} tagObject
 * @param {Object|null} referralTagObject
 * @param {Object} domainConfig
 * @param {string} securityType
 * @param {Object} authUser
 */
const persistZelfIdLease = async (tagObject, referralTagObject, domainConfig, securityType, authUser) => {
    const tagName = tagObject.tagName || tagObject.zelfName;
    const tagKey = domainConfig.getTagKey?.() || "tagName";
    const referralBare = (
        referralTagObject?.publicData?.[tagKey] ||
        referralTagObject?.publicData?.tagName ||
        referralTagObject?.publicData?.zelfName ||
        ""
    )
        .toString()
        .split(".")[0];
    const priced = getZelfIdPrice({
        tagName,
        duration: `${tagObject.duration || "1"}`,
        referralTagName: referralBare ? `${referralBare}.${domainConfig.name}` : "",
        domainConfig,
    });

    tagObject.price = priced.price;
    tagObject.reward = priced.reward;
    tagObject.discount = priced.discount;
    tagObject.discountType = priced.discountType;

    const quotePrice = Number(priced.price);

    tagObject.price = 0;

    const complimentary = resolveComplimentaryPlan({ tagName, price: quotePrice });

    await ZelfIdsRegistrationModule.confirmZelfId(tagObject, referralTagObject, domainConfig, securityType, authUser, {
        plan: complimentary || resolveZelfIdPlan({ tagName }),
    });
};

const applyExpiredPlanDowngrade = (result) => {
    const publicData = result?.tagObject?.publicData;
    if (!publicData) return result;

    const plan = effectivePlan(publicData);
    if (plan === publicData.plan) return result;

    result.tagObject.publicData = { ...publicData, plan };
    return result;
};

/**
 * Available-name search/preview pricing via the Zelf ID license (not Tags `getPrice`).
 * `price` matches payment-options upgrade USD (`getZelfIdCheckoutPrice`); lease plan stays `free`.
 * @param {Object} result
 * @param {Object} context
 * @param {string} context.tagName
 * @param {string} [context.duration]
 * @param {Object} context.domainConfig
 * @returns {Object}
 */
const attachAvailableZelfIdPricing = (result, { tagName, duration, domainConfig }) => {
    if (!result?.available || !domainConfig) return result;

    const leaseQuote = getZelfIdPrice({
        tagName,
        duration: duration || "1",
        domainConfig,
    });
    const upgradeQuote = getZelfIdCheckoutPrice({
        tagName,
        duration: duration || "1",
        domainConfig,
    });

    const price = {
        ...upgradeQuote,
        plan: leaseQuote.plan,
        allowedPlans: leaseQuote.allowedPlans,
    };

    return {
        ...result,
        price,
        plan: leaseQuote.plan,
        allowedPlans: leaseQuote.allowedPlans,
    };
};

/**
 * Unpin an unpaid reservation whose window has passed and mark the name available.
 * Paid mainnet records are left alone.
 * @param {Object} result - search result
 * @param {Object} context
 * @returns {Promise<Object>}
 */
const releaseExpiredUnpaidReservation = async (result, context = {}) => {
    const publicData = result?.tagObject?.publicData || {};

    if (!isUnpaidExpiredReservation(publicData)) {
        return result;
    }

    const ipfsId = result.tagObject.id || result.tagObject.ipfsId;
    const canonicalName = publicData.tagName || publicData.zelfName || context.tagName;

    try {
        if (canonicalName) {
            await unpinContinuationSiblings(canonicalName);
        }

        if (ipfsId) {
            await unPinFiles([ipfsId]);
        }
    } catch (error) {
        console.error({ releaseExpiredUnpaidReservation: error });
    }

    const available = {
        ...result,
        available: true,
        tagObject: undefined,
        ipfs: [],
        arweave: [],
    };

    delete available.tagObject;

    return attachAvailableZelfIdPricing(available, {
        tagName: context.tagName,
        duration: context.duration || "1",
        domainConfig: context.domainConfig,
    });
};

const _findDuplicatedTag = async (tagName, domain, domainConfig) => {
    const result = await searchTag({
        tagName,
        domain,
        domainConfig,
        environment: "all",
    });

    assertTagAvailable(result);

    return result;
};

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

const _decryptParams = async (params, authUser) => {
    if (params.removePGP) {
        return {
            password: params.password,
            mnemonic: params.mnemonic,
            face: params.faceBase64,
        };
    }

    const password = params.password ? await SessionModule.sessionDecrypt(params.password, authUser) : null;
    const mnemonic = params.mnemonic ? await SessionModule.sessionDecrypt(params.mnemonic, authUser) : null;
    const face = params.faceBase64 ? await SessionModule.sessionDecrypt(params.faceBase64, authUser) : null;

    return {
        password,
        mnemonic,
        face,
    };
};

/**
 * Decrypt the stored proof on v4 then unpin IPFS.
 * Inbound: `tagName`, `domain`, `faceBase64` required; `password` optional.
 *
 * @param {Object} params
 * @param {Object} authUser
 * @returns {Promise<{ tagObject: Object, deletedFiles: Array }>}
 */
const deleteTag = async (params, authUser) => {
    const { tagName, domain, faceBase64, password } = params;

    const searchResult = await searchTag({ tagName, domain }, authUser);

    if (!searchResult?.tagObject?.zelfProof) {
        const error = new Error("404:tag_not_found");
        error.status = 404;
        throw error;
    }

    const zelfProof = searchResult.tagObject.zelfProof;

    const ipfsID = searchResult.tagObject.id;

    const publicData = searchResult.tagObject.publicData || {};
    const decryptPayload = { faceBase64, password, zelfProof };
    const decryptedZelfProof = await decrypt(withV4(decryptPayload));

    if (decryptedZelfProof.error) {
        const error = new Error(decryptedZelfProof.error.code);
        error.status = 409;
        throw error;
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
    getDomainConfig,
    generateDomainHoldDomain,
    persistZelfIdLease,
    releaseExpiredUnpaidReservation,
    _findDuplicatedTag,
    _validateReferral,
    _createWalletsFromPhrase,
    _decryptParams,
};
