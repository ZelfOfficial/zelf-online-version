const ZelfIdModule = require("./zelf-id.module");
const ZelfIdPartsModule = require("./zelf-id-parts.module");
const { decrypt } = require("../../ZelfProof/modules/zelf-proof.module");
const { getDomainConfig } = require("../../Tags/config/supported-domains");
const { effectivePassword, resolveSecurityType } = require("./zelf-id-password.module");

const withV4 = (data) => ({ ...data, stack: "v4" });

/**
 * Re-lease from an existing proof (import onto a name). Always v4.
 *
 * Inbound after Joi: `zelfProof`, `tagName`, `domain`, `faceBase64`, `os` required.
 * Optional: `password` (omit or send the placeholder for face-only), `securityType`, `addServerPassword`, `referralTagName`, `tolerance`, `duration`, `removePGP`, `captchaToken`.
 *
 * @param {Object} payload
 * @param {Object} authUser
 * @returns {Promise<Object>}
 */
const leaseRecovery = async (payload, authUser) => {
    const { zelfProof, tagName, domain, type, os, addServerPassword, referralTagName } = payload;

    const duration = payload.duration || 1;

    const domainConfig = getDomainConfig(domain);

    const zelfProofRecord = await ZelfIdModule.searchTag({ key: "zelfProof", value: zelfProof, domain, domainConfig }, authUser);

    if (zelfProofRecord?.tagObject) {
        return { ...zelfProofRecord.tagObject, message: "Zelf Proof found and is being used by another tag" };
    }

    await ZelfIdModule._findDuplicatedTag(tagName, domain, domainConfig);

    const { face, password: rawPassword } = await ZelfIdPartsModule.decryptParams(payload, authUser);

    // Face-only: no password (placeholder accepted for older clients).
    const password = effectivePassword({ password: rawPassword, securityType: payload.securityType });

    const decryptedZelfProof = await decrypt(
        withV4({
            addServerPassword: Boolean(addServerPassword),
            faceBase64: face,
            password,
            zelfProof,
            os: os || "DESKTOP",
        })
    );

    const referralTagObject = await ZelfIdModule._validateReferral(referralTagName, authUser, domainConfig);

    const { eth, btc, solana, sui, stellar, polkadot, kusama, ton, aptos, zkProof, mnemonic, arweave } = await ZelfIdModule._createWalletsFromPhrase({
        faceBase64: face,
        password,
        type: "import",
        mnemonic: decryptedZelfProof.metadata.mnemonic,
    });

    const tagKey = domainConfig.getTagKey();

    await _assertSourceNameNotActive(decryptedZelfProof.publicData?.[tagKey], domain, domainConfig, eth.address, tagName);

    const dataToEncrypt = {
        publicData: {
            ethAddress: eth.address,
            solanaAddress: solana.address,
            btcAddress: btc.address,
            stellarAddress: stellar.address,
            [tagKey]: tagName,
            domain: domain,
            origin: "online",
            v: "4",
        },
        metadata: {
            mnemonic,
            solanaSecretKey: solana.secretKey,
        },
        faceBase64: face,
        ...(password ? { password } : {}),
        _id: tagName,
        tolerance: payload.tolerance,
        addServerPassword: Boolean(payload.addServerPassword),
    };

    const tagObject = {
        ...dataToEncrypt.publicData,
        duration,
        origin: "online",
        v: "4",
    };

    const skipZelfProof = decryptedZelfProof.publicData[tagKey] === tagName;

    ZelfIdPartsModule.assignProperties(
        tagObject,
        dataToEncrypt,
        { eth, btc, solana, sui, stellar, arweave, polkadot, kusama, ton, aptos },
        { ...payload, password, referralTagObject },
        domainConfig
    );

    await ZelfIdPartsModule.generateZelfProof(dataToEncrypt, tagObject);

    tagObject.zelfProof = skipZelfProof ? zelfProof : tagObject.zelfProof;

    const securityType = resolveSecurityType(password, payload.securityType);

    await ZelfIdModule.persistZelfIdLease(tagObject, referralTagObject, domainConfig, securityType, authUser);

    const pgp = await ZelfIdPartsModule.generatePGPKeys(
        dataToEncrypt,
        { eth, btc, solana, sui, stellar, arweave, polkadot, kusama, ton, aptos },
        password || rawPassword
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
        pgp,
    };
};

/**
 * Refuse recovery when the proof's original name is still active for the same wallet:
 * that is a sign-in, not a recovery, and would mint a second name for one wallet.
 * Expired names (expiresAt in the past) may be recovered onto a new name.
 */
const _assertSourceNameNotActive = async (sourceName, domain, domainConfig, ethAddress, newTagName) => {
    if (!sourceName || sourceName === newTagName) return;

    let result;

    try {
        result = await ZelfIdModule.searchTag({ tagName: sourceName, domain, domainConfig, environment: "all" });
    } catch (_error) {
        return;
    }

    if (!result || result.available) return;

    const publicData = result.tagObject?.publicData || {};

    if (publicData.ethAddress && ethAddress && publicData.ethAddress.toLowerCase() !== ethAddress.toLowerCase()) return;

    const expiresAt = publicData.expiresAt ? new Date(publicData.expiresAt).getTime() : NaN;

    if (Number.isFinite(expiresAt) && expiresAt < Date.now()) return;

    throw new Error("409:zelf_id_still_active");
};

module.exports = {
    leaseRecovery,
    _assertSourceNameNotActive,
};
