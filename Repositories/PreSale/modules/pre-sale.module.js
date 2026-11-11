const Stripe = require("stripe");
const config = require("../../../Core/config");

const Mailgun = require("../../../Core/mailgun");
const IPFS = require("../../IPFS/modules/ipfs.module");

const ZNSTokenModule = require("../../ZelfNameService/modules/zns-token.module");
const MyTagsModule = require("../../Tags/modules/my-tags.module");
const { extractDomainAndName } = require("../../Tags/middlewares/tags.middleware");
const { isDomainActive } = require("../../Tags/config/supported-domains");
const axios = require("axios");

const testingStripeCards = {
    4242424242424242: "tok_visa",
    4000000000003220: "tok_mastercard",
    378282246310005: "tok_amex",
    // Add more test cards as needed
    4000000000009999: "tok_visa",
    4000000000000002: "tok_mastercard",
    378282246310005: "tok_amex",
};

const templatesMap = {
    en: {
        Presale_receipt: {
            subject: "ZNS Token Pre-Sale Receipt",
            template: "purchase receipt",
        },
    },
};

const sendReceiptEmail = async ({ email, amount, tokens, transactionId, date }) => {
    const template = templatesMap.en.Presale_receipt;

    const formatDate = (date) =>
        new Intl.DateTimeFormat("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "numeric",
            minute: "numeric",
            second: "numeric",
            hour12: true,
        }).format(new Date(date));

    const extraParams = {
        "recipient-variables": {
            [email]: {
                transactionDate: formatDate(date || new Date()),
                subtotal: amount,
                total: amount,
                tokens: tokens,
                transactionId: transactionId,
                product: "ZNS Pre-Sale Tokens",
            },
        },
    };

    try {
        await Mailgun.sendEmail(email, template.subject, template.template, extraParams);
        return { success: true };
    } catch (error) {
        console.error("Error sending receipt email:", error);
        throw error;
    }
};

// Initialize Stripe with the secret key from config
const stripe = Stripe(config.stripe.secretKey);

// Configuration for Pre-Sale
const PRESALE_CONFIG = {
    tokenPrice: 0.05, // USD per token
    bonusTiers: [
        { minAmount: 1000, bonus: 0.5, label: "50% BONUS" },
        { minAmount: 500, bonus: 0.25, label: "25% BONUS" },
        { minAmount: 100, bonus: 0.1, label: "10% BONUS" },
        { minAmount: 0, bonus: 0, label: "NO BONUS" },
    ],
};

const getBonusTier = (amount) => {
    return PRESALE_CONFIG.bonusTiers.find((tier) => amount >= tier.minAmount) || PRESALE_CONFIG.bonusTiers[PRESALE_CONFIG.bonusTiers.length - 1];
};

const { getPresaleLicenseExtensionYears } = require("./presale-license.util");
const {
    RELEASE_SOURCE_VERIFIED_WEBHOOK,
    assertVerifiedReleaseSource,
    buildAtomicReleaseUpdate,
    isLicenseExtensionRecorded,
    isTokenPayoutRecorded,
    lockUnavailableError,
    tokensAlreadyReleasedError,
} = require("./presale-release.util");
const PresaleRelease = require("../models/presale-release.model");

const calculateTokens = (usdAmount) => {
    const tier = getBonusTier(usdAmount);
    const baseTokens = usdAmount / PRESALE_CONFIG.tokenPrice;
    const bonusTokens = baseTokens * tier.bonus;

    return {
        baseTokens,
        bonusTokens,
        totalTokens: baseTokens + bonusTokens,
        bonusPercentage: tier.bonus * 100,
    };
};

/**
 * Create a Stripe Checkout Session for ZNS Token Pre-Sale
 * @param {Object} params
 * @param {number} params.amount - Amount in USD
 * @param {string} params.email - Optional customer email
 * @param {string} params.zelfName - Required Zelf Name (tag) for token delivery
 * @param {string} params.solanaAddress - Optional Solana address for token delivery
 * @returns {Promise<Object>} The created session URL and ID
 */
const createStripeSession = async ({ amount, email, zelfName, solanaAddress }) => {
    try {
        const frontendUrl = config.landingUrl;

        // Calculate tokens server-side for security
        const { totalTokens, bonusPercentage } = calculateTokens(amount);

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ["card"],
            line_items: [
                {
                    price_data: {
                        currency: "usd",
                        product_data: {
                            name: "ZNS Token Pre-Sale",
                            description: `${totalTokens.toLocaleString()} ZNS Tokens (${bonusPercentage > 0 ? bonusPercentage + "% Bonus Included" : "Base Allocation"})`,
                            images: ["https://zelf.world/assets/images/zns-token.png"],
                        },
                        unit_amount: Math.round(amount * 100), // Stripe expects cents
                    },
                    quantity: 1,
                },
            ],
            mode: "payment",
            success_url: `${frontendUrl}/presale/success?session_id={CHECKOUT_SESSION_ID}&method=stripe`,
            cancel_url: `${frontendUrl}/presale/checkout?canceled=true&method=stripe`,
            customer_email: email,
            metadata: {
                type: "zns_presale",
                tokens: totalTokens.toString(),
                bonus: bonusPercentage.toString(),
                zelfName: zelfName || "",
                solanaAddress: solanaAddress || "",
            },
        });

        return {
            url: session.url,
            sessionId: session.id,
            calculated: {
                amount,
                tokens: totalTokens,
                bonus: bonusPercentage,
            },
        };
    } catch (error) {
        console.error("Error creating Stripe session:", error);
        throw error;
    }
};

/**
 * Get Payment/Session Details and Confirm Transaction
 * @param {string} sessionIdOrCode
 * @returns {Promise<Object>}
 */
/**
 * Check if a receipt exists in IPFS
 */
const _checkIPFSRecord = async (sessionId) => {
    const records = await IPFS.get({ key: "presaleSessionId", value: sessionId });

    return records && records.length > 0 ? records[0] : null;
};

/**
 * Verify payment status with Stripe
 */
const _verifyWithProvider = async (sessionIdOrCode) => {
    let details = {};
    let isPaid = false;

    if (sessionIdOrCode.startsWith("cs_")) {
        // Stripe
        const session = await stripe.checkout.sessions.retrieve(sessionIdOrCode);
        isPaid = session.payment_status === "paid";

        details = {
            method: "stripe",
            status: session.payment_status,
            amount: session.amount_total / 100,
            email: session.customer_details?.email || session.customer_email,
            metadata: session.metadata,
            currency: session.currency,
        };
    } else {
        return {
            isPaid: false,
            details: {
                method: "unsupported",
                status: "coinbase_removed",
            },
        };
    }

    return { isPaid, details };
};

/**
 * Attempt to release tokens if address is available
 */
const _releasePendingTokens = async (amount, address) => {
    if (!address) return { released: false, signature: "" };

    try {
        const signature = await ZNSTokenModule.giveTokensAfterPurchase(amount, address);

        return { released: true, signature };
    } catch (err) {
        console.error("Failed to release tokens:", err);
        return { released: false, signature: "" };
    }
};

/**
 * Attempt to extend tag license as a presale reward (best-effort).
 * @param {string} zelfName - Full tag name (e.g. "alice.zelf")
 * @param {number} amountUSD - Purchase amount in USD
 * @returns {Promise<Object>}
 */
const _extendTagLicenseForPresale = async (zelfName, amountUSD) => {
    const emptyResult = (error) => ({
        extended: false,
        years: 0,
        tagName: null,
        domain: null,
        expiresAt: null,
        ipfsId: null,
        error,
    });

    if (!zelfName?.trim()) {
        return emptyResult("zelf_name_missing");
    }

    const years = getPresaleLicenseExtensionYears(amountUSD);
    if (!years) {
        return emptyResult("no_extension_tier");
    }

    const { domain, name } = extractDomainAndName(zelfName.trim());
    if (!domain || !name) {
        return emptyResult("invalid_zelf_name");
    }

    if (!isDomainActive(domain)) {
        return emptyResult("unsupported_domain");
    }

    try {
        const renewal = await MyTagsModule.extendTagDurationFree(name, domain, years);
        return {
            extended: true,
            years,
            tagName: name,
            domain,
            expiresAt: renewal.expiresAt,
            ipfsId: renewal.ipfsId,
            error: null,
        };
    } catch (err) {
        console.error("Presale license extension failed:", err);
        return emptyResult(err.message || "extension_failed");
    }
};

const {
    buildPresaleReceiptIpfsMetadata: _buildPresaleReceiptIpfsMetadata,
    parseReceiptSummary: _parseReceiptSummary,
    validatePresaleReceiptMetadata: _validatePresaleReceiptMetadata,
} = require("./presale-receipt-ipfs-metadata.util");

const _isTruthyMetadataFlag = (value) => value === true || value === "true";

const _parseLegacyPaymentDetails = (publicData) => {
    if (!publicData?.paymentDetails) return {};
    try {
        return JSON.parse(publicData.paymentDetails);
    } catch (e) {
        console.error("Error parsing paymentDetails JSON", e);
        return {};
    }
};

const _readPresaleReceiptFlags = (publicData) => {
    const legacy = _parseLegacyPaymentDetails(publicData);

    return {
        tokensReleased:
            _isTruthyMetadataFlag(publicData.tokensReleased) || legacy.tokensReleased === true,
        licenseExtended:
            _isTruthyMetadataFlag(publicData.licenseExtended) || legacy.licenseExtended === true,
    };
};

/**
 * Save or update receipt in IPFS
 */
const _saveReceiptToIPFS = async (existingRecord, data) => {
    const { sessionId, details, totalTokens, bonusPercentage, released, address, signature, zelfName, licenseExtension } = data;

    const receiptData = {
        sessionId: sessionId,
        date: new Date().toISOString(),
        email: details.email,
        amountUSD: details.amount,
        method: details.method,
        zelfName: zelfName || "",
        tokens: {
            total: totalTokens,
            bonusPercentage: bonusPercentage,
        },
        paymentDetails: details,
        release: {
            released: released,
            address: address,
            signature: signature,
            date: released ? new Date().toISOString() : null,
        },
        licenseExtension: licenseExtension || { extended: false },
    };

    const licenseExtended = licenseExtension?.extended === true;

    const ipfsMetadata = _buildPresaleReceiptIpfsMetadata({
        sessionId,
        details,
        totalTokens,
        bonusPercentage,
        released,
        address,
        signature,
        zelfName,
        licenseExtension,
    });

    _validatePresaleReceiptMetadata(ipfsMetadata);

    const base64Data = Buffer.from(JSON.stringify(receiptData)).toString("base64");
    const fileName = `presale_receipt_${sessionId}.json`;

    if (existingRecord) {
        const keyvalues = existingRecord.publicData || {};
        const { tokensReleased: alreadyReleased, licenseExtended: alreadyLicenseExtended } =
            _readPresaleReceiptFlags(keyvalues);

        const shouldUpdate =
            (released && !alreadyReleased) ||
            (licenseExtended && !alreadyLicenseExtended);

        if (shouldUpdate) {
            await IPFS.unPinFiles([existingRecord.ipfs_pin_hash]);
            await IPFS.insert(
                {
                    base64: base64Data,
                    name: fileName,
                    metadata: ipfsMetadata,
                    pinIt: true,
                },
                { pro: true },
            );
        }
    } else {
        // Insert new record
        await IPFS.insert(
            {
                base64: base64Data,
                name: fileName,
                metadata: ipfsMetadata,
                pinIt: true,
            },
            { pro: true },
        );
    }

    return receiptData;
};

/**
 * Get Payment/Session Details and Confirm Transaction
 * @param {string} sessionIdOrCode
 * @returns {Promise<Object>}
 */
/**
 * Format details from an existing IPFS record
 */
const _formatDetailsFromRecord = (existingRecord) => {
    const publicData = existingRecord.publicData || {};
    const legacy = _parseLegacyPaymentDetails(publicData);
    const summary = _parseReceiptSummary(publicData);
    const { tokensReleased, licenseExtended } = _readPresaleReceiptFlags(publicData);

    return {
        method: publicData.method || "unknown",
        status: "paid",
        amount: parseFloat(publicData.amountUSD || summary.amountUSD || legacy.amountUSD || "0"),
        email: publicData.presaleEmail || publicData.email,
        metadata: {
            tokens: (publicData.totalTokens ?? summary.totalTokens ?? legacy.totalTokens)?.toString(),
            solanaAddress: publicData.presaleSolanaAddress || legacy.solanaAddress || publicData.solanaAddress,
            bonus: (publicData.bonusPercentage ?? summary.bonusPercentage ?? legacy.bonusPercentage)?.toString(),
            tokensReleased,
            transactionSignature:
                publicData.transactionSignature || summary.transactionSignature || legacy.transactionSignature || "",
            zelfName: publicData.presaleZelfName || publicData.zelfName || "",
            licenseExtended,
            licenseExtensionYears: Number(
                publicData.licenseExtensionYears ?? summary.licenseExtensionYears ?? legacy.licenseExtensionYears ?? 0
            ),
            licenseExtensionExpiresAt:
                publicData.licenseExtensionExpiresAt ||
                summary.licenseExtensionExpiresAt ||
                legacy.licenseExtensionExpiresAt ||
                "",
            licenseExtensionTag:
                publicData.licenseExtensionTag || summary.licenseExtensionTag || legacy.licenseExtensionTag || "",
        },
        currency: "USD",
    };
};

/**
 * Process a paid transaction: Release tokens and store receipt
 */
const _processPayment = async (sessionIdOrCode, details, isPaid, existingRecord, options = {}) => {
    assertVerifiedReleaseSource(options.source);

    if (!isPaid) return details;

    const totalTokens = parseFloat(details.metadata?.tokens || "0");
    const bonusPercentage = parseFloat(details.metadata?.bonus || "0");

    // Prefer address from metadata (provider) or existing record
    const solanaAddress = details.metadata?.solanaAddress || details.metadata?.address;

    // Get zelfName from metadata (passed during session creation)
    const zelfName = details.metadata?.zelfName || "";

    const mongoState = await PresaleRelease.findOne({ sessionId: sessionIdOrCode }).lean();
    const payoutTx = mongoState?.payoutTx || details.metadata?.transactionSignature || "";
    const tokensAlreadyReleased = isTokenPayoutRecorded({
        tokensReleased: mongoState?.tokensReleased === true || details.metadata?.tokensReleased === true,
        payoutTx,
    });

    const storedLicenseRecord =
        mongoState?.licenseRecord ||
        details.metadata?.licenseExtensionExpiresAt ||
        details.metadata?.licenseExtensionTag ||
        "";
    const licenseAlreadyExtended = isLicenseExtensionRecorded({
        licenseExtended: mongoState?.licenseExtended === true || details.metadata?.licenseExtended === true,
        licenseRecord: storedLicenseRecord,
    });

    const licenseExtensionSkipped = !String(zelfName || "").trim() || getPresaleLicenseExtensionYears(details.amount) === 0;

    if (tokensAlreadyReleased && (licenseAlreadyExtended || licenseExtensionSkipped)) {
        throw tokensAlreadyReleasedError();
    }

    let releaseResult = {
        released: tokensAlreadyReleased,
        signature: payoutTx,
    };

    if (!tokensAlreadyReleased) {
        releaseResult = await _releasePendingTokens(totalTokens, solanaAddress);
    }

    let licenseResult = {
        extended: licenseAlreadyExtended,
        years: details.metadata?.licenseExtensionYears || 0,
        tagName: null,
        domain: null,
        expiresAt: details.metadata?.licenseExtensionExpiresAt || storedLicenseRecord || null,
        ipfsId: null,
        error: null,
    };

    if (!licenseAlreadyExtended && !licenseExtensionSkipped) {
        licenseResult = await _extendTagLicenseForPresale(zelfName, details.amount);
    }

    const licenseExtensionTag =
        licenseResult.tagName && licenseResult.domain
            ? `${licenseResult.tagName}.${licenseResult.domain}`
            : details.metadata?.licenseExtensionTag || "";

    const recordedPayoutTx = releaseResult.released ? releaseResult.signature || payoutTx : "";
    const recordedLicense =
        licenseResult.extended
            ? String(licenseResult.expiresAt || licenseResult.ipfsId || licenseExtensionTag || storedLicenseRecord || "")
            : licenseAlreadyExtended
              ? storedLicenseRecord
              : "";

    const releaseUpdate = buildAtomicReleaseUpdate({
        payoutTx: recordedPayoutTx,
        licenseRecord: recordedLicense,
    });

    if (Object.keys(releaseUpdate).length) {
        await PresaleRelease.findOneAndUpdate({ sessionId: sessionIdOrCode }, { $set: releaseUpdate }, { upsert: true, new: true });
    }

    // Save/Update IPFS
    const receipt = await _saveReceiptToIPFS(existingRecord, {
        sessionId: sessionIdOrCode,
        details: details,
        totalTokens: totalTokens,
        bonusPercentage: bonusPercentage,
        released: Boolean(releaseUpdate.tokensReleased),
        address: solanaAddress,
        signature: releaseUpdate.payoutTx || "",
        zelfName: zelfName,
        licenseExtension: licenseResult,
    });

    return {
        method: details.method,
        status: "paid",
        amount: details.amount,
        email: details.email,
        zelfName: zelfName,
        metadata: {
            tokens: totalTokens.toString(),
            bonus: bonusPercentage.toString(),
            released: Boolean(releaseUpdate.tokensReleased),
            solanaAddress: solanaAddress,
            transactionSignature: releaseUpdate.payoutTx || "",
            zelfName: zelfName,
            licenseExtended: licenseResult.extended,
            licenseExtensionYears: licenseResult.years,
            licenseExtensionExpiresAt: licenseResult.expiresAt,
            licenseExtensionTag,
        },
        currency: "USD",
        receipt: receipt,
    };
};

const PresaleLock = require("../models/presale-lock.model");

/**
 * Acquire distributed lock for session
 */
const _acquireSessionLock = async (sessionId) => {
    try {
        await PresaleLock.create({ sessionId });
        return true;
    } catch (e) {
        if (e.code !== 11000) console.error("Lock acquisition error:", e);
        throw lockUnavailableError();
    }
};

/**
 * Release distributed lock for session
 */
const _releaseSessionLock = async (sessionId) => {
    try {
        await PresaleLock.deleteOne({ sessionId });
    } catch (e) {
        console.error("Error releasing lock:", e);
    }
};

/**
 * Get Payment/Session Details and Confirm Transaction
 * @param {string} sessionIdOrCode
 * @returns {Promise<Object>}
 */
const getPaymentDetails = async (sessionIdOrCode) => {
    const existingRecord = await _checkIPFSRecord(sessionIdOrCode);

    if (existingRecord) {
        return {
            ..._formatDetailsFromRecord(existingRecord),
            ipfsHash: existingRecord.ipfs_pin_hash,
        };
    }

    const verification = await _verifyWithProvider(sessionIdOrCode);
    return verification.details;
};

/**
 * Release tokens and extend the license only after the Stripe webhook signature has been verified
 * and the Checkout Session has been re-fetched as paid.
 */
const releaseFromVerifiedStripeEvent = async (event) => {
    const allowedTypes = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded"]);

    if (!allowedTypes.has(event?.type)) {
        return { status: "ignored" };
    }

    const eventSession = event.data?.object;
    if (!eventSession?.id || eventSession.metadata?.type !== "zns_presale") {
        return { status: "ignored" };
    }

    const session = await stripe.checkout.sessions.retrieve(eventSession.id);

    if (session.metadata?.type !== "zns_presale" || session.payment_status !== "paid") {
        return { status: "ignored", reason: "not_paid" };
    }

    let lockAcquired = false;

    try {
        await _acquireSessionLock(session.id);
        lockAcquired = true;

        const existingRecord = await _checkIPFSRecord(session.id);
        const formatted = existingRecord ? _formatDetailsFromRecord(existingRecord) : null;

        const details = {
            method: "stripe",
            status: session.payment_status,
            amount: session.amount_total / 100,
            email: session.customer_details?.email || session.customer_email || formatted?.email,
            metadata: {
                ...(session.metadata || {}),
                tokensReleased: formatted?.metadata?.tokensReleased === true,
                transactionSignature: formatted?.metadata?.transactionSignature || "",
                licenseExtended: formatted?.metadata?.licenseExtended === true,
                licenseExtensionYears: formatted?.metadata?.licenseExtensionYears || 0,
                licenseExtensionExpiresAt: formatted?.metadata?.licenseExtensionExpiresAt || "",
                licenseExtensionTag: formatted?.metadata?.licenseExtensionTag || "",
                zelfName: session.metadata?.zelfName || formatted?.metadata?.zelfName || "",
                solanaAddress: session.metadata?.solanaAddress || formatted?.metadata?.solanaAddress || "",
            },
            currency: session.currency || "USD",
        };

        const result = await _processPayment(session.id, details, true, existingRecord, {
            source: RELEASE_SOURCE_VERIFIED_WEBHOOK,
        });

        return { status: "released", result };
    } catch (error) {
        if (error.code === "TOKENS_ALREADY_RELEASED") {
            return { status: "already_released", code: "TOKENS_ALREADY_RELEASED" };
        }
        throw error;
    } finally {
        if (lockAcquired) {
            await _releaseSessionLock(session.id);
        }
    }
};

module.exports = {
    createStripeSession,
    calculateTokens,
    getPresaleLicenseExtensionYears,
    sendReceiptEmail,
    getPaymentDetails,
    releaseFromVerifiedStripeEvent,
};
