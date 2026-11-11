const config = require("../../../Core/config");
const { searchTag } = require("./tags.module");
const TagsSearchModule = require("./tags-search.module");
const moment = require("moment");
const { getDomainConfig } = require("../config/supported-domains");
const jwt = require("jsonwebtoken");
const bitcoinModule = require("../../bitcoin/modules/bitcoin-scrapping.module");
const ETHModule = require("../../etherscan/modules/etherscan-scrapping.module");
const solanaModule = require("../../Solana/modules/solana-scrapping.module");
const AvalancheModule = require("../../Avalanche/modules/avalanche-scrapping.module");
const { sendCustomEmail } = require("../../../Core/mailgun");
const { isRemovedChain, isRemovedDomain, unsupportedChainError, unsupportedDomainError } = require("../../../Core/removed-blockdag");
const { buildMetadata, ensureZelfProofQRCode, storeInIPFS, storeInWalrus, storeInArweave } = require("./tags-payment.module");
const { parseTagPayAmount, coerceInitiatedAtUnix, filterSessionInboundTransactions } = require("./tag-pay-session-tx.util");
const { verifySmartContractPayment, throwPaymentConfirmationTagNotFound } = require("./tag-smart-contract-payment.module");

const ReferralRewardModel = require("../models/referral-rewards.model");
const TagsTokenModule = require("./tags-token.module");
const IPFS = require("../../../Core/ipfs");
const TagsArweaveModule = require("./tags-arweave.module");
const LicenseModule = require("../../License/modules/license.module");



/**
 * Renew my tag
 * @param {string} tagName
 * @param {string} domain
 * @param {string} network
 * @param {string} token
 */
const verifyPaymentConfirmation = async (tagName, domain, network, token) => {
    if (isRemovedDomain(domain)) throw unsupportedDomainError();
    if (isRemovedChain(network)) throw unsupportedChainError();

    const tokenDecoded = jwt.verify(token, config.JWT_SECRET);

    const domainConfig = getDomainConfig(domain);

    if (!tokenDecoded || !tokenDecoded.tagName || !tokenDecoded.tagPayName) throw new Error("401:tag_not_authenticated");

    // Verify the tag belongs to the user
    if (tokenDecoded.tagName !== `${tagName}.${domain}`) throw new Error("403:tag_not_owned");

    if (network === "AVAX") {
        throw new Error("409:avax_use_smart_contract_confirmation");
    }

    // Get current tag data
    const tagData = await searchTag({ tagName, domain }, {});

    if (tagData.available) throwPaymentConfirmationTagNotFound(tagName, domain);

    const tagObject = tagData.tagObject;

    const amountToPay = tokenDecoded.prices[network]?.amountToSend;

    const initiatedAtUnix = coerceInitiatedAtUnix(tokenDecoded.initiatedAt);

    const addressMapping = {
        ETH: tokenDecoded.paymentAddress.ethAddress,
        SOL: tokenDecoded.paymentAddress.solanaAddress,
        BTC: tokenDecoded.paymentAddress.btcAddress,
        AVAX: tokenDecoded.paymentAddress.avalancheAddress || tokenDecoded.paymentAddress.ethAddress,
    };

    const paymentConfirmation = await confirmPayUniqueAddress(network, addressMapping[network], amountToPay, { initiatedAtUnix });

    const initiatedAt = tokenDecoded.initiatedAt ? moment.unix(tokenDecoded.initiatedAt) : null;

    const renewedAtCondition = Boolean(tagObject.publicData.renewedAt && initiatedAt && moment(tagObject.publicData.renewedAt).isAfter(initiatedAt));

    const registeredAtCondition = Boolean(tokenDecoded.initiatedAt && moment(tagObject.publicData.registeredAt).isAfter(initiatedAt));

    if (renewedAtCondition || registeredAtCondition) {
        return {
            cache: true,
            confirmed: paymentConfirmation.confirmed,
            amountReceived: paymentConfirmation.amountReceived,
            paymentConfirmation,
            publicData: tagObject.publicData,
            reward: "pending_to_code",
            //await getPurchaseReward(zelfNameObject.publicData.zelfName, moment(authUser.payment.registeredAt)),
        };
    }

    const paymentOk =
        paymentConfirmation && typeof paymentConfirmation === "object" && paymentConfirmation.confirmed === true;

    if (!paymentOk) {
        const _paymentConfirmation = paymentConfirmation && typeof paymentConfirmation === "object" ? paymentConfirmation : null;

        return {
            tagObject,
            confirmed: false,
            amountReceived: _paymentConfirmation?.amountReceived ?? 0,
            ...(_paymentConfirmation ? { paymentConfirmation: _paymentConfirmation } : {}),
        };
    }

    await addDurationToTag(
        {
            tagName: tagObject.publicData[domainConfig.getTagKey()].split(".")[0],
            price: amountToPay,
            domain,
            duration: tokenDecoded.duration || 1,
            domainConfig,
        },
        tagObject
    );

    return {
        tagObject,
        confirmed: true,
        amountReceived: paymentConfirmation.amountReceived,
    };
};

const isETHPaymentConfirmed = async (address, amountToPay, initiatedAtUnix) => {
    const amountNum = parseTagPayAmount(amountToPay);
    if (amountNum == null) {
        return {
            confirmed: false,
            amountReceived: 0,
            amountToPay,
            checkedFactor: "invalid_amount",
        };
    }
    try {
        const response = await ETHModule.getAddress({ address });

        const numericBalance = Number(response?.balance ?? 0);

        if (!Number.isNaN(numericBalance) && numericBalance <= amountNum) {
            return {
                confirmed: false,
                amountReceived: 0,
                amountToPay: amountNum,
                transactions: response?.transactions,
                balance: response?.balance,
                checkedFactor: "balance",
            };
        }

        const sessionTxs = filterSessionInboundTransactions(response?.transactions, initiatedAtUnix);
        const amountReceived = sessionTxs.reduce((sum, transaction) => sum + Number(transaction.amount), 0);

        return {
            confirmed: amountReceived >= amountNum,
            amountReceived,
            amountToPay: amountNum,
            transactions: response?.transactions,
            balance: response?.balance,
            checkedFactor: "transactions",
        };
    } catch (error) {
        console.error(error);
    }

    return false;
};

const isSolanaPaymentConfirmed = async (address, amountToPay, initiatedAtUnix) => {
    const amountNum = parseTagPayAmount(amountToPay);

    if (amountNum == null) {
        return {
            confirmed: false,
            amountReceived: 0,
            amountToPay,
            checkedFactor: "invalid_amount",
        };
    }

    try {
        const response = await solanaModule.getAddress({ id: address });

        const numericBalance = Number(response?.balance ?? 0);

        if (!Number.isNaN(numericBalance) && numericBalance <= amountNum) {
            return {
                confirmed: false,
                amountReceived: 0,
                amountToPay: amountNum,
                transactions: response?.transactions,
                balance: response?.balance,
                checkedFactor: "balance",
            };
        }

        const sessionTxs = filterSessionInboundTransactions(response?.transactions, initiatedAtUnix);

        const amountReceived = sessionTxs.reduce((sum, transaction) => sum + Number(transaction.amount), 0);

        return {
            confirmed: amountReceived >= amountNum,
            amountReceived,
            amountToPay: amountNum,
            transactions: response?.transactions,
            balance: response?.balance,
            checkedFactor: "transactions",
        };
    } catch (error) { }

    return false;
};

/**
 * Check if Avalanche payment is confirmed
 * @param {string} address
 * @param {number} amountToPay
 * @returns {Promise<Object>}
 */
const isAvalanchePaymentConfirmed = async (address, amountToPay, initiatedAtUnix) => {
    const amountNum = parseTagPayAmount(amountToPay);
    if (amountNum == null) {
        return {
            confirmed: false,
            amountReceived: 0,
            amountToPay,
            checkedFactor: "invalid_amount",
        };
    }
    try {
        const response = await AvalancheModule.getBalance({ id: address });

        const numericBalance = Number(response?.balance ?? 0);

        if (!Number.isNaN(numericBalance) && numericBalance <= amountNum) {
            return {
                confirmed: false,
                amountReceived: 0,
                amountToPay: amountNum,
                transactions: response?.transactions,
                balance: response?.balance,
                checkedFactor: "balance",
            };
        }

        const sessionTxs = filterSessionInboundTransactions(response?.transactions, initiatedAtUnix);
        const amountReceived = sessionTxs.reduce((sum, transaction) => sum + Number(transaction.amount), 0);

        return {
            confirmed: amountReceived >= amountNum,
            amountReceived,
            amountToPay: amountNum,
            transactions: response?.transactions,
            balance: response?.balance,
            checkedFactor: "transactions",
        };
    } catch (error) {
        console.error(error);
    }

    return false;
};

/**
 * checkout BTC comparison
 * @param {String} address
 * @param {Number} amountDetected
 * @returns Boolean
 */
const isBTCPaymentConfirmed = async (address, zelfNamePrice) => {
    const priceNum = parseTagPayAmount(zelfNamePrice);
    if (priceNum == null) {
        return {
            amountReceived: "0",
            confirmed: false,
            zelfNamePrice,
            checkedFactor: "invalid_amount",
        };
    }
    try {
        const response = await bitcoinModule.getBalance({
            id: address,
        });

        const numericReceived = Number(response?.balance ?? 0);
        const amountReceived = Number.isNaN(numericReceived) ? "0" : numericReceived.toFixed(7);

        return {
            amountReceived,
            confirmed: !Number.isNaN(numericReceived) && numericReceived === priceNum,
            zelfNamePrice: priceNum,
        };
    } catch (error) { }

    return false;
};

const confirmPayUniqueAddress = async (network, address, amountToPay, options = {}) => {
    if (isRemovedChain(network)) throw unsupportedChainError();
    const { initiatedAtUnix } = options;
    const map = {
        ETH: isETHPaymentConfirmed,
        SOL: isSolanaPaymentConfirmed,
        BTC: isBTCPaymentConfirmed,
        AVAX: isAvalanchePaymentConfirmed,
    };

    try {
        const fn = map[network];
        if (!fn) {
            throw new Error("409:unsupported_payment_network");
        }

        if (network === "BTC") {
            return await fn(address, amountToPay);
        }
        const confirmation = await fn(address, amountToPay, initiatedAtUnix);

        return confirmation;
    } catch (exception) {
        console.error(exception);
        if (exception?.message && /^\d{3}:/.test(String(exception.message))) {
            throw exception;
        }

        const error = new Error("payment_confirmation_failed");
        error.status = 500;

        throw error;
    }
};

/**
 * Transfer my tag
 * @param {Object} params
 * @param {Object} authUser
 */
const transferMyTag = async (params, authUser) => {
    return "not-implemented";
};

/**
 * Update old tag object
 * @param {Object} tagObject
 * @param {string} domain
 */
const updateOldTagObject = async (tagObject, domain = "zelf") => {
    return "not-implemented";
};

/**
 * Add duration to tag (for RevenueCat webhook)
 * @param {Object} params - Parameters including tagName, domain, duration, eventID, eventPrice
 * @param {Object} preview - Tag preview object
 * @returns {Promise<{ tagObject: Object, expiresAt: string|null, ipfsId: string|null, arweaveId: string|null, masterIPFSRecord: Object, masterArweaveRecord: Object|null, arweaveSkipped: boolean, warnings: string[] }>}
 */
const addDurationToTag = async (params, tagObject) => {
    const { tagName, domain, duration, price } = params;

    const domainConfig = params.domainConfig || getDomainConfig(domain || "zelf");

    const { metadata } = buildMetadata(params, tagObject, domainConfig);

    await ensureZelfProofQRCode(tagObject);

    if (domainConfig.isWalrusEnabled()) {
        await storeInWalrus(tagObject, domainConfig, metadata);
    }

    if (domainConfig.isIPFSEnabled()) {
        await storeInIPFS(tagObject, domainConfig, metadata);
    }

    if (domainConfig.isArweaveEnabled()) {
        await storeInArweave(tagObject, domainConfig, metadata);
    }

    let expiresAt = null;
    try {
        if (metadata?.extraParams && typeof metadata.extraParams === "string") {
            const parsed = JSON.parse(metadata.extraParams);
            expiresAt = parsed.expiresAt || null;
        }
    } catch (_) {
        /* optional */
    }

    const arweaveSkipped = Boolean(tagObject.arweave?.skipped);
    const warnings = [];
    if (arweaveSkipped && domainConfig.isArweaveEnabled()) {
        warnings.push("arweave_upload_skipped_file_too_large");
    }

    const ipfsRec = tagObject.ipfs;
    const arwRec = tagObject.arweave;

    return {
        tagObject,
        expiresAt,
        ipfsId: ipfsRec?.id ?? tagObject.ipfsId ?? null,
        arweaveId: arweaveSkipped ? null : arwRec?.id ?? null,
        masterIPFSRecord: ipfsRec,
        masterArweaveRecord: arweaveSkipped ? null : arwRec,
        arweaveSkipped,
        warnings,
    };
};

const sendEmailReceipt = async (tagName, domain, network, email, token) => {
    const tokenDecoded = jwt.verify(token, config.JWT_SECRET);

    if (!tokenDecoded) {
        throw new Error("invalid_token");
    }

    // Get current tag data
    const tagData = await searchTag({ tagName, domain }, {});

    if (tagData.available) {
        const error = new Error("tag_not_found");
        error.status = 404;
        throw error;
    }

    const tagObject = tagData.tagObject;

    const price =
        tokenDecoded.prices[network]?.price ||
        tokenDecoded.prices.ETH?.price ||
        tokenDecoded.prices.SOL?.price ||
        tokenDecoded.prices.BTC?.price ||
        tokenDecoded.prices.AVAX?.price;

    // Format dates for better readability
    const transactionDate = moment(tagObject.publicData.registeredAt).format("YYYY-MM-DD HH:mm:ss");
    const expiresDate = moment(tagObject.publicData.expiresAt).format("YYYY-MM-DD HH:mm:ss");
    const yearLabel = tokenDecoded.duration === 1 ? "1 YEAR" : `${tokenDecoded.duration} YEARS`;

    return await sendCustomEmail(
        email,
        "purchase_receipt",
        {
            subject: `Your Zelf Domain Receipt - ${tokenDecoded.tagName}`,
            tagName: tokenDecoded.tagName,
            transactionDate,
            expires: expiresDate,
            subtotal: price,
            discount: tokenDecoded.discount || 0,
            total: price - (tokenDecoded.discount || 0),
            year: tokenDecoded.duration,
            yearLabel,
        },
        tokenDecoded.language || "en"
    );
};

/**
 * 1. Create reward record if not found (status "pending").
 * 2. Call giveTokensAfterPurchase to send ZNS.
 * 3. On success: set status "completed", receipt fields (completedAt, payload, attempts++), save. Return { signature, rewardAmount }.
 * 4. On failure: set status "failed", payload.error, attempts++, save. Throw so user can retry later.
 * @param {Object|null} rewardRecord - Existing record or null to create one
 * @param {string} friendFullTagName - Friend's full tag (e.g. one5024.sui)
 * @param {string} friendDomain - Friend's domain
 * @param {string} referralTagName - Referrer's full tag (e.g. miguel.zelf)
 * @param {string} domain - Referrer's domain
 * @param {Object} referrerTagRecord - Referrer's tag from IPFS (publicData.solanaAddress, publicData.ethAddress = who we reward)
 * @param {Object} friendRecord - IPFS/Arweave record for the friend's tag
 * @param {number} rewardAmount - ZNS amount to send
 * @returns {Promise<{ signature: string, rewardAmount: number }>}
 * @throws {Error} "token_transfer_failed" when giveTokensAfterPurchase fails (record is updated to "failed", attempts incremented)
 */
const _sendReferralRewardAndUpdateRecord = async (
    rewardRecord,
    friendFullTagName,
    friendDomain,
    referralTagName,
    domain,
    referrerTagRecord,
    friendRecord,
    rewardAmount,
    rewardType
) => {
    const referrerSolanaAddress = referrerTagRecord?.publicData?.solanaAddress;

    const referrerEthAddress = referrerTagRecord?.publicData?.ethAddress || "not_set";

    if (!referrerSolanaAddress) {
        const err = new Error("referrer_tag_solana_address_not_found");
        err.status = 400;
        throw err;
    }

    const tagNameOnly = friendFullTagName.split(".")[0];
    const keyFriendName = rewardType === "registration" ? `${tagNameOnly}.hold` : friendFullTagName;

    // 1. Create record if not found (addresses from referrer's tag in IPFS)
    if (!rewardRecord) {
        rewardRecord = new ReferralRewardModel({
            tagName: keyFriendName,
            domain: friendDomain,
            ethAddress: referrerEthAddress,
            solanaAddress: referrerSolanaAddress,
            referralTagName,
            referralDomain: domain,
            referralSolanaAddress: referrerSolanaAddress,
            tagPrice: friendRecord.publicData?.price || 0,
            status: "pending",
            attempts: 0,
            payload: {},
            ipfsHash: friendRecord.ipfsHash || "",
            arweaveId: friendRecord.arweaveId || "",
            rewardType,
        });
    }

    // 2. Send ZNS to referrer's Solana address (from their tag in IPFS)
    let signature;

    try {
        signature = await TagsTokenModule.giveTokensAfterPurchase(rewardAmount, referrerSolanaAddress);
    } catch (error) {
        console.error("Error sending referral reward:", error);

        rewardRecord.status = "failed";

        rewardRecord.payload = { ...rewardRecord.payload, error: error?.message || "token_transfer_failed" };

        rewardRecord.attempts += 1;

        await rewardRecord.save();

        const err = new Error("token_transfer_failed");

        err.status = 502;

        throw err;
    }

    // 3. Success: store receipt in IPFS and update MongoDB
    const ipfsCid = await _storeReferralRewardReceipt({
        rewardRecord,
        friendFullTagName,
        friendDomain,
        referralTagName,
        domain,
        rewardAmount,
        signature,
        referrerSolanaAddress,
        referrerEthAddress,
        friendRecord,
        rewardType,
    });

    return { signature, rewardAmount, ipfsCid };
};

/**
 * Store referral reward receipt in IPFS and update MongoDB record.
 * @param {Object} params - Receipt parameters
 * @returns {Promise<string|null>} IPFS CID or null if storage failed
 */
const _storeReferralRewardReceipt = async ({
    rewardRecord,
    friendFullTagName,
    friendDomain,
    referralTagName,
    domain,
    rewardAmount,
    signature,
    referrerSolanaAddress,
    referrerEthAddress,
    friendRecord,
    rewardType,
}) => {
    const rewardDate = moment().format("YYYY-MM-DD");
    const tagNameOnly = friendFullTagName.split(".")[0];
    const keyFriendName = rewardType === "registration" ? `${tagNameOnly}.hold` : friendFullTagName;
    const rewardPrimaryKey = `referral_${keyFriendName}_${referralTagName}`;

    const rewardData = {
        type: "referral",
        rewardType,
        rewardPrimaryKey,
        referralTagName,
        referralDomain: domain,
        friendTagName: keyFriendName,
        friendDomain,
        rewardAmount,
        signature,
        referrerSolanaAddress,
        referrerEthAddress,
        friendTagPrice: friendRecord.publicData?.price || 0,
        friendTagType: friendRecord.publicData?.type || "hold",
        rewardDate,
        redeemedAt: moment().format("YYYY-MM-DD HH:mm:ss"),
        status: "completed",
    };

    // Store reward receipt as JSON in IPFS
    const rewardJson = JSON.stringify(rewardData);
    const base64Json = Buffer.from(rewardJson).toString("base64");
    const filename = `referral-reward-${rewardPrimaryKey}.json`;

    // Metadata for IPFS querying
    const ipfsMetadata = {
        rewardPrimaryKey,
        rewardedTagName: referralTagName,
        friendTagName: keyFriendName,
        rewardType: "referral",
        referralRewardType: rewardType,
        rewardDate,
    };

    let ipfsResult = null;
    let arweaveResult = null;

    // Store in IPFS
    try {
        ipfsResult = await IPFS.pinFile(`data:application/json;base64,${base64Json}`, filename, "application/json", ipfsMetadata);
    } catch (ipfsError) {
        console.error("Error storing referral reward in IPFS:", ipfsError);
    }

    // Store in Arweave (required by the model schema) — same JSON payload as IPFS
    try {
        const rewardDataUrl = `data:application/json;base64,${base64Json}`;

        arweaveResult = await TagsArweaveModule.receiptRegistration(
            rewardDataUrl,
            {
                zelfProof: null,
                hasPassword: false,
                publicData: {
                    type: "referral_reward",
                    rewardType,
                    rewardPrimaryKey,
                    referralTagName,
                    referralDomain: domain,
                    friendTagName: keyFriendName,
                    friendDomain,
                    rewardAmount: String(rewardAmount),
                    signature,
                    rewardDate,
                    status: "completed",
                },
            },
            `referral-reward-${rewardPrimaryKey}`
        );
    } catch (arweaveError) {
        console.error("Error storing referral reward in Arweave:", arweaveError);
    }

    // Update MongoDB record with receipt
    rewardRecord.status = "completed";
    rewardRecord.completedAt = new Date();
    rewardRecord.payload = {
        signature,
        rewardAmount,
        ipfsCid: ipfsResult?.IpfsHash || null,
        arweaveId: arweaveResult?.id || null,
    };
    rewardRecord.attempts += 1;
    rewardRecord.solanaAddress = referrerSolanaAddress;
    rewardRecord.ethAddress = referrerEthAddress;

    if (ipfsResult?.IpfsHash) {
        rewardRecord.ipfsHash = ipfsResult.IpfsHash;
    }

    // Set arweaveId (required field) - use the ID from Arweave or fallback to IPFS hash
    rewardRecord.arweaveId = arweaveResult?.id || ipfsResult?.IpfsHash || `pending_${Date.now()}`;

    await rewardRecord.save();

    return {
        signature,
        rewardAmount,
        ipfsCid: ipfsResult?.IpfsHash || null,
        arweaveId: arweaveResult?.id || null,
    };
};

/**
 * Step 1: Verify referral exists in IPFS/Arweave and return the friend's record.
 * @param {string} referralTagName - Full referrer tag (e.g. miguel.zelf)
 * @param {string} friendFullTagName - Full friend tag to find (e.g. one5024.sui)
 * @param {string} friendDomain - Friend's domain
 * @param {string} rewardType - "registration" or "purchase"
 * @param {Object} authUser - Authenticated user (referrer)
 * @returns {Promise<Object>} The friend's IPFS/Arweave record
 * @throws {Error} "referral_not_found" if no record matches friendFullTagName
 */
const _findReferralRecordInStorage = async (referralTagName, friendFullTagName, friendDomain, rewardType, authUser) => {
    const domainConfig = getDomainConfig(friendDomain);

    const ipfsRecords = await TagsSearchModule.searchIPFS(
        {
            key: "referralTagName",
            value: referralTagName,
            domain: friendDomain,
            domainConfig,
        },
        authUser
    );

    const arweaveRecords = await TagsSearchModule.searchArweave(
        {
            key: "referralTagName",
            value: referralTagName,
            domain: friendDomain,
            domainConfig,
        },
        authUser
    );

    const records = [...ipfsRecords, ...arweaveRecords];

    const targetName = rewardType === "registration" ? `${friendFullTagName}.hold` : friendFullTagName;

    const friendRecord = records.find((r) => (r.publicData?.tagName || r.publicData?.zelfName) === targetName);

    if (!friendRecord) throw new Error("referral_not_found");

    return friendRecord;
};

/**
 * Derive duration string for getPrice from tag's registeredAt and expiresAt.
 * @param {string} registeredAt - e.g. '2026-01-29 11:30:07'
 * @param {string} expiresAt - e.g. '2027-01-29 11:30:07'
 * @returns {string} "1" | "2" | "3" | "4" | "5" | "lifetime"
 */
const _durationFromRegisteredAndExpires = (registeredAt, expiresAt) => {
    if (!registeredAt || !expiresAt) return "1";
    const start = moment(registeredAt);
    const end = moment(expiresAt);
    if (!start.isValid() || !end.isValid() || end.isSameOrBefore(start)) return "1";
    const years = end.diff(start, "years", true);
    if (years >= 5) return "lifetime";
    const durationYears = Math.min(5, Math.max(1, Math.round(years)));
    return String(durationYears);
};

/**
 * Step 3: Calculate referral reward amount (ZNS tokens).
 * - Registration (hold): fixed 10 ZNS.
 * - Purchase (mainnet): 10% of friend's tag purchase price, converted to ZNS.
 * @param {Object} friendRecord - Friend's IPFS/Arweave record
 * @param {Object} domainConfig - Domain config
 * @param {string} rewardType - "registration" or "purchase"
 * @returns {number} ZNS reward amount
 */
const _calculateReferralRewardAmount = (friendRecord, domainConfig, rewardType = null) => {
    // If rewardType is not provided, derive it from record status (for backward compatibility if needed)
    if (!rewardType) {
        const type = friendRecord.publicData?.type || friendRecord.metadata?.extraParams?.type || "hold";
        rewardType = type === "mainnet" ? "purchase" : "registration";
    }

    if (rewardType === "registration") {
        return 10; // Flat 10 ZNS for registration
    }

    // Purchase reward: 10% of tag price
    let tagPrice = friendRecord.publicData?.price || friendRecord.metadata?.extraParams?.price || 0;

    if (!tagPrice) {
        const registeredAt = friendRecord.publicData?.registeredAt || friendRecord.metadata?.extraParams?.registeredAt;
        const expiresAt = friendRecord.publicData?.expiresAt || friendRecord.metadata?.extraParams?.expiresAt;
        const duration = _durationFromRegisteredAndExpires(registeredAt, expiresAt);
        const tagNameForPrice = friendRecord.name || friendRecord.tagName || friendRecord.publicData?.tagName || friendRecord.publicData?.zelfName;
        const priceResult = domainConfig.getPrice(tagNameForPrice, duration);
        tagPrice = priceResult?.price ?? 0;
    }

    const znsPrice = config.token?.rewardPrice || 0.05; // Cents per ZNS
    let rewardAmount = 0;

    if (tagPrice > 0) {
        rewardAmount = (tagPrice * 0.1) / znsPrice;
    }

    return Math.round(rewardAmount * 10000) / 10000;
};

/**
 * Step 4: Check if referral reward has already been claimed.
 * @param {string} friendFullTagName - Friend's full tag
 * @param {string} referralTagName - Referrer's full tag
 * @param {string} rewardType - "registration" or "purchase"
 */
const _checkIfRewardAlreadyClaimed = async (friendFullTagName, referralTagName, rewardType) => {
    const keyFriendName = rewardType === "registration" ? `${friendFullTagName}.hold` : friendFullTagName;

    const rewardPrimaryKey = `referral_${keyFriendName}_${referralTagName}`;

    const ipfsRewards = await IPFS.filter("rewardPrimaryKey", rewardPrimaryKey);

    if (ipfsRewards && ipfsRewards.length > 0) throw new Error("reward_already_claimed");

    // Backup: Check MongoDB
    const rewardRecord = await ReferralRewardModel.findOne({
        tagName: keyFriendName,
        referralTagName: referralTagName,
        rewardType, // Distinguish records in Mongo too
    });

    if (rewardRecord && rewardRecord.status === "completed") throw new Error("reward_already_claimed");

    return rewardRecord;
};

/**
 * Claim referral reward
 * @param {string} tagName - Referrer tag name
 * @param {string} domain - Referrer domain
 * @param {string} friendTagName - Friend tag name
 * @param {string} friendDomain - Friend domain
 * @param {Object} authUser - Authenticated user (referrer)
 */
const claimReferralReward = async (tagName, domain, friendTagName, friendDomain, authUser, rewardType = null) => {
    const referralTagName = tagName.includes(".") ? tagName : `${tagName}.${domain}`;

    const friendFullTagName = friendTagName.includes(".") ? friendTagName : `${friendTagName}.${friendDomain}`;

    // 1. Verify referral exists in IPFS/Arweave
    const friendRecord = await _findReferralRecordInStorage(referralTagName, friendFullTagName, friendDomain, rewardType, authUser);

    const normalizedDomain = (domain || "").replace(/^\./, "").trim().toLowerCase();

    if (isRemovedDomain(normalizedDomain) || isRemovedDomain(friendDomain)) throw unsupportedDomainError();

    const domainConfig = getDomainConfig(normalizedDomain);

    if (!domainConfig) throw new Error("400:domain_not_supported");

    const referrerTagData = await searchTag({ tagName: referralTagName, domain: normalizedDomain }, {});

    if (referrerTagData.available || !referrerTagData.tagObject) throw new Error("404:referrer_tag_not_found");

    const referrerTagRecord = referrerTagData.tagObject;

    // Derived type if not provided
    if (!rewardType) {
        const type = friendRecord.publicData?.type || friendRecord.metadata?.extraParams?.type || "hold";
        rewardType = type === "mainnet" ? "purchase" : "registration";
    }

    const rewardRecord = await _checkIfRewardAlreadyClaimed(friendFullTagName, referralTagName, rewardType);

    const rewardAmount = _calculateReferralRewardAmount(friendRecord, domainConfig, rewardType);

    const {
        signature,
        rewardAmount: amount,
        ipfsCid,
    } = await _sendReferralRewardAndUpdateRecord(
        rewardRecord,
        friendFullTagName,
        friendDomain,
        referralTagName,
        domain,
        referrerTagRecord,
        friendRecord,
        rewardAmount,
        rewardType
    );

    return { success: true, rewardAmount: amount, signature, ipfsCid };
};

/**
 * Get my referrals for a specific tag (referrer) in a single domain.
 * Includes claim status and rewarded amount.
 * @param {string} tagName - Referrer tag name without domain (e.g. "miguel")
 * @param {string} domain - Domain (e.g. "zelf") -> full referrer tag = "miguel.zelf"
 * @param {Object} authUser
 */
const getMyReferrals = async (tagName, domain, authUser) => {
    const referralTagName = tagName.includes(".") ? tagName : `${tagName}.${domain}`;

    const domainConfig = getDomainConfig(domain);

    const ipfsRecords = await TagsSearchModule.searchIPFS(
        {
            key: "referralTagName",
            value: referralTagName,
            domain,
            domainConfig,
        },
        authUser
    );

    const arweaveRecords = await TagsSearchModule.searchArweave(
        {
            key: "referralTagName",
            value: referralTagName,
            domain,
            domainConfig,
        },
        authUser
    );

    const domainRecords = [...ipfsRecords, ...arweaveRecords];

    const tagKey = domainConfig?.getTagKey?.() || "tagName";

    const map = new Map();

    for (const record of domainRecords) {
        const name = record.publicData?.[tagKey] || record.name || record.tagName || record.publicData?.tagName || record.publicData?.zelfName;

        if (!name) continue;

        if (!map.has(name)) {
            map.set(name, record);
        }
    }

    const referrals = [];
    let totalEarnedInZNS = 0;

    for (const [name, record] of map) {
        if (!name) continue;

        const type = record.publicData?.type || record.metadata?.extraParams?.type || "hold";

        const tagNameOnly = name.split(".")[0];

        // 1. Check Registration Reward (10 ZNS)
        const regKeyFriendName = `${tagNameOnly}.hold`;
        const regPrimaryKey = `referral_${regKeyFriendName}_${referralTagName}`;
        const ipfsRegReward = (await IPFS.filter("rewardPrimaryKey", regPrimaryKey))?.[0];
        const mongoRegRecord = await ReferralRewardModel.findOne({
            tagName: regKeyFriendName,
            referralTagName,
            rewardType: "registration",
        });

        const regClaimed = !!ipfsRegReward || (mongoRegRecord && mongoRegRecord.status === "completed");

        const regAmount = ipfsRegReward?.publicData?.rewardAmount || mongoRegRecord?.payload?.rewardAmount || 10;

        if (regClaimed) totalEarnedInZNS += Number(regAmount);

        referrals.push({
            ...record,
            name,
            status: "tag_name_created",
            rewardZNS: 10,
            claimed: !!regClaimed,
            claimStatus: regClaimed ? "completed" : mongoRegRecord?.status || "none",
            rewardAmount: regClaimed ? Number(regAmount) : 0,
            rewardType: "registration",
            ipfsHash: ipfsRegReward?.cid || mongoRegRecord?.ipfsHash || null,
        });

        // 2. Check Purchase Reward (10%) - only if mainnet
        if (type === "mainnet") {
            const purPrimaryKey = `referral_${name}_${referralTagName}`;
            const ipfsPurReward = (await IPFS.filter("rewardPrimaryKey", purPrimaryKey))?.[0];
            const mongoPurRecord = await ReferralRewardModel.findOne({
                tagName: name,
                referralTagName,
                rewardType: "purchase", // or just null for legacy
            });

            const purClaimed = !!ipfsPurReward || (mongoPurRecord && mongoPurRecord.status === "completed");
            const purAmountPotential = _calculateReferralRewardAmount(record, domainConfig, "purchase");
            const purAmountActual = ipfsPurReward?.publicData?.rewardAmount || mongoPurRecord?.payload?.rewardAmount || purAmountPotential;

            if (purClaimed) totalEarnedInZNS += Number(purAmountActual);

            referrals.push({
                ...record,
                name,
                status: "tag_name_purchased",
                rewardZNS: purAmountPotential,
                claimed: !!purClaimed,
                claimStatus: purClaimed ? "completed" : mongoPurRecord?.status || "none",
                rewardAmount: purClaimed ? Number(purAmountActual) : 0,
                rewardType: "purchase",
                ipfsHash: ipfsPurReward?.cid || mongoPurRecord?.ipfsHash || null,
            });
        }
    }

    return {
        referrals,
        totalEarnedInZNS,
    };
};

/**
 * Extend tag duration without payment (server-side reward flows).
 * @param {string} tagName - Tag name (without domain)
 * @param {string} domain - Domain (e.g. "zelf")
 * @param {number} durationYears - Duration in years
 * @returns {Promise<Object>} Renewal result from addDurationToTag
 */
const extendTagDurationFree = async (tagName, domain, durationYears) => {
    const domainConfig = getDomainConfig(domain);

    const tagData = await searchTag({ tagName, domain }, {});

    if (tagData.available) {
        const error = new Error("tag_not_found");
        error.status = 404;
        throw error;
    }

    const tagObject = tagData.tagObject;

    const tagKey = domainConfig.getTagKey();

    const tagStorageValue = tagObject.publicData[tagKey];

    if (typeof tagStorageValue !== "string" || !tagStorageValue.trim()) {
        throw new Error("422:tag_storage_value_missing");
    }

    return addDurationToTag(
        {
            tagName: tagStorageValue.split(".")[0],
            price: 0,
            domain,
            duration: Number(durationYears),
            domainConfig,
        },
        tagObject
    );
};

/**
 * Extend license for tag owner (free extension).
 * Verifies that the caller owns the domain license via biometric credentials,
 * then extends the tag duration without requiring payment.
 * @param {string} tagName - Tag name (without domain)
 * @param {string} domain - Domain (e.g. "zelf")
 * @param {string|number} duration - Duration in years or "lifetime"
 * @param {Object} ownershipCredentials - { faceBase64, password }
 * @param {Object} authUser - Authenticated user (JWT)
 * @returns {Object} - Updated tag object
 */
const extendLicenseForOwner = async (tagName, domain, duration, ownershipCredentials, authUser) => {
    // 1. Verify that the user is the domain/license owner
    const { faceBase64, password } = ownershipCredentials;

    const { myLicense } = await LicenseModule.getMyLicense(authUser, true, {
        faceBase64,
        masterPassword: password,
    });

    if (!myLicense) {
        const error = new Error("license_not_found");
        error.status = 404;
        throw error;
    }

    // 2. Verify the license domain matches the requested domain
    const licenseDomain = myLicense.publicData?.licenseDomain || myLicense.domainConfig?.name;

    if (!licenseDomain || licenseDomain.toLowerCase() !== domain.toLowerCase()) {
        const error = new Error("domain_not_owned");
        error.status = 403;
        throw error;
    }

    const durationYears = duration === "lifetime" ? 100 : Number(duration);
    const renewal = await extendTagDurationFree(tagName, domain, durationYears);

    return {
        success: true,
        tagName: `${tagName}.${domain}`,
        domain,
        duration,
        message: "License extended successfully",
        expiresAt: renewal.expiresAt,
        ipfsId: renewal.ipfsId,
        arweaveId: renewal.arweaveId,
        arweaveSkipped: renewal.arweaveSkipped,
        warnings: renewal.warnings,
    };
};

module.exports = {
    verifyPaymentConfirmation,
    verifySmartContractPayment,
    transferMyTag,
    updateOldTagObject,
    addDurationToTag,
    extendTagDurationFree,
    extendLicenseForOwner,
    // Utility functions
    sendEmailReceipt,
    getMyReferrals,
    claimReferralReward,
};
