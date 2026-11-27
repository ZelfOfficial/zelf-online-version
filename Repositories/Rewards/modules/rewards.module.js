const crypto = require("crypto");
const IPFS = require("../../../Core/ipfs");
const ZNSSearchModule = require("../../ZelfNameService/modules/zns-search.module");
const ZNSTokenModule = require("../../ZelfNameService/modules/zns-token.module");
const NotificationService = require("../services/notification.service");
const Model = require("../models/rewards.model"); // MongoDB model for TTL cache
const RewardTransfer = require("../../Tags/modules/referral-reward-transfer");
const moment = require("moment");
const ZNSTransactionDetector = require("../../ZelfNameService/modules/zns-transaction-detector.module");
const { normalizeZelfName } = require("../middlewares/rewards.middleware");
const TagsSearchModule = require("../../Tags/modules/tags-search.module");
const { getDomainConfig } = require("../../Tags/config/supported-domains");
const TagsPartsModule = require("../../Tags/modules/tags-parts.module");
const TagsModule = require("../../Tags/modules/tags.module");
const ZelfProofModule = require("../../ZelfProof/modules/zelf-proof.module");
const { isNoPassword } = require("../../ZelfID/modules/zelf-id-password.module");
const { assertPayoutAddressAllowed, isPayoutAddressBlockedError } = require("../../ZelfNameService/modules/zns-payout-denylist");

/** Client codes for daily-reward identity checks. Statuses match Zelf Keys ownership decrypt. */
const REWARD_IDENTITY_STATUS = {
    ERR_IDENTITY_VERIFICATION_REQUIRED: 400,
    ERR_MISSING_PASSWORD: 400,
    ERR_INVALID_PASSWORD: 401,
    ERR_PASSWORD_REQUIRED: 409,
    ERR_VERIFICATION_FAILED: 422,
    ERR_SESSION_OWNER_MISMATCH: 403,
};

const DAILY_REWARD_ALREADY_CLAIMED = "DAILY_REWARD_ALREADY_CLAIMED";
const DAILY_REWARD_PAYOUT_FAILED = "DAILY_REWARD_PAYOUT_FAILED";
const DAILY_REWARD_CLAIM_IN_PROGRESS = "DAILY_REWARD_CLAIM_IN_PROGRESS";
/** A processing row with no stored signature can be taken again once the request that held it is gone. */
const DAILY_CLAIM_LOCK_STALE_MS = 90 * 1000;
/** Rolling window from the last successful claim. A calendar date does not open a new spin. */
const DAILY_REWARD_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WHEEL_SEGMENTS = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
const DAILY_REWARD_COOLDOWN_MESSAGE = "You have already claimed your daily reward. Come back when 24 hours have passed.";

const throwRewardIdentityError = (code) => {
    const status = REWARD_IDENTITY_STATUS[code] || 422;
    const error = new Error(`${status}:${code}`);

    error.status = status;
    error.code = code;
    error.clientCode = code;
    error.clientMessage = code;

    throw error;
};

const throwDailyRewardError = (status, code, clientMessage = code, extra) => {
    const error = new Error(`${status}:${code}`);

    error.status = status;
    error.code = code;
    error.clientCode = code;
    error.clientMessage = clientMessage;

    if (extra?.nextClaimAvailable) error.nextClaimAvailable = extra.nextClaimAvailable;

    throw error;
};

const _parseRewardTime = (value) => {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

    if (typeof value === "number" && Number.isFinite(value)) {
        const date = new Date(value);

        return Number.isNaN(date.getTime()) ? null : date;
    }

    if (typeof value !== "string" || !value.trim()) return null;

    const parsed = moment(value.trim(), ["YYYY-MM-DD HH:mm:ss", moment.ISO_8601, "YYYY-MM-DD"], true);

    return parsed.isValid() ? parsed.toDate() : null;
};

const _claimTime = (record) => {
    const candidates = [
        record?.redeemedAt,
        record?.payload?.redeemedAt,
        record?.claimedAt,
        record?.publicData?.redeemedAt,
        record?.metadata?.redeemedAt,
        record?.publicData?.claimedAt,
        record?.metadata?.claimedAt,
        record?.rewardDate,
        record?.publicData?.rewardDate,
        record?.metadata?.rewardDate,
    ];

    for (const candidate of candidates) {
        const parsed = _parseRewardTime(candidate);

        if (parsed) return parsed;
    }

    return null;
};

/** A stored daily payout, including an IPFS receipt that has no Mongo status. */
const _isConfirmedDailyClaim = (record) => {
    if (!record) return false;

    if (record.status === "claimed" || record.payload?.payoutConfirmed === true || record.source === "ipfs") return true;

    return !record.status && Boolean(record.metadata || record.publicData || record.ipfs_pin_hash);
};

/**
 * True while a confirmed claim is less than 24 hours old.
 * A confirmed row with no timestamp still blocks, so a receipt cannot be paid twice.
 * @param {Object|null} record
 * @param {number} [now]
 * @returns {boolean}
 */
const _isWithinDailyCooldown = (record, now = Date.now()) => {
    if (!_isConfirmedDailyClaim(record)) return false;

    const claimTime = _claimTime(record);

    if (!claimTime) return true;

    return now - claimTime.getTime() < DAILY_REWARD_COOLDOWN_MS;
};

const _nextClaimAvailableAt = (record, now = Date.now()) => {
    const claimTime = _claimTime(record);

    return new Date((claimTime ? claimTime.getTime() : now) + DAILY_REWARD_COOLDOWN_MS).toISOString();
};

const _throwDailyCooldown = (record) => {
    throwDailyRewardError(409, DAILY_REWARD_ALREADY_CLAIMED, DAILY_REWARD_COOLDOWN_MESSAGE, {
        nextClaimAvailable: _nextClaimAvailableAt(record),
    });
};

const _dailyRewardSlotKey = (zelfName) => `${zelfName}:daily`;

const _dailyRewardLookupKeys = (zelfName) => [
    _dailyRewardSlotKey(zelfName),
    `${zelfName}${moment().format("YYYY-MM-DD")}`,
    `${zelfName}${moment().subtract(1, "day").format("YYYY-MM-DD")}`,
];

const _modifiedCount = (result) => result?.modifiedCount ?? result?.nModified ?? 0;

const _isDuplicateKey = (error) => error?.code === 11000 || /E11000|duplicate key/i.test(String(error?.message || ""));

const _dailyClaimExpiresAt = () => moment().add(2, "days").toDate();

const isRewardIdentityError = (error) => {
    const message = typeof error?.message === "string" ? error.message.trim() : "";

    if (/^\d{3}:ERR_[A-Z0-9_]+$/.test(message)) return true;

    return typeof error?.code === "string" && Object.prototype.hasOwnProperty.call(REWARD_IDENTITY_STATUS, error.code);
};

const safeRewardErrorText = (error) => {
    const message = typeof error?.message === "string" ? error.message.trim() : "";

    if (/^\d{3}:[A-Za-z0-9_]+$/.test(message)) return message;

    if (typeof error?.code === "string" && /^[A-Za-z0-9_]+$/.test(error.code)) return error.code;

    return "Failed to process daily reward";
};

/**
 * Zelf ID password for the rewarded name. Extension sends `masterPassword`;
 * `password` is the same secret. Blank values and the face-only placeholder are absent.
 * @param {Object} data
 * @returns {string|undefined}
 */
const resolveRewardMasterPassword = (data) => {
    const candidates = [data?.masterPassword, data?.password];

    for (const candidate of candidates) {
        if (typeof candidate !== "string") continue;
        if (candidate.trim() === "") continue;
        if (isNoPassword(candidate.trim())) continue;

        return candidate;
    }

    return undefined;
};

const hasPasswordFlag = (publicData) => {
    const flag = publicData?.hasPassword;

    return flag === true || String(flag).toLowerCase() === "true";
};

/**
 * Whether this Zelf ID's proof has a password layer.
 * `passwordLayer` from preview wins over a stale `publicData.hasPassword`.
 * @param {Object} tagObject
 * @returns {Promise<boolean>}
 */
const proofRequiresPassword = async (tagObject) => {
    const zelfProof = tagObject?.zelfProof;

    if (typeof zelfProof === "string" && zelfProof) {
        try {
            const previewResult = await ZelfProofModule.previewWithLegacyFallback({ zelfProof });

            ZelfProofModule.applyPreviewHasPassword(tagObject, previewResult);

            const fromLayer = ZelfProofModule.passwordLayerRequiresPassword(previewResult?.passwordLayer);

            if (fromLayer === true || fromLayer === false) return fromLayer;
        } catch (_previewError) {
            // Preview can be down. The ownership decrypt still enforces the proof's password layer.
        }
    }

    return hasPasswordFlag(tagObject?.publicData);
};

const mapOwnershipDecryptError = (error) => {
    if (isRewardIdentityError(error) && typeof error?.message === "string" && /^\d{3}:ERR_/.test(error.message.trim())) {
        throw error;
    }

    const code = typeof error?.code === "string" ? error.code : "";

    if (REWARD_IDENTITY_STATUS[code]) throwRewardIdentityError(code);

    const normalized = String(error?.message || "").toLowerCase();

    if (normalized.includes("password") && normalized.includes("invalid")) {
        throwRewardIdentityError("ERR_INVALID_PASSWORD");
    }

    if (normalized.includes("password") && normalized.includes("required")) {
        throwRewardIdentityError("ERR_PASSWORD_REQUIRED");
    }

    if (
        normalized.includes("liveness") ||
        normalized.includes("face is not central") ||
        normalized.includes("no face detected") ||
        normalized.includes("multiple face") ||
        normalized.includes("face not recognized") ||
        normalized.includes("verification failed")
    ) {
        throwRewardIdentityError("ERR_VERIFICATION_FAILED");
    }

    throw error;
};

/**
 * Prove the caller controls the Zelf ID being rewarded (`tagName` + `domain`).
 * Uses the same ownership decrypt as Zelf Keys store/delete. The decrypted payload is discarded.
 * @param {Object} data
 * @param {Object} tagObject
 * @param {Object} authUser
 */
const assertDailyRewardIdentity = async (data, tagObject, authUser) => {
    const faceBase64 = typeof data?.faceBase64 === "string" ? data.faceBase64.trim() : "";

    if (!faceBase64) throwRewardIdentityError("ERR_IDENTITY_VERIFICATION_REQUIRED");

    const masterPassword = resolveRewardMasterPassword(data);
    const requiresPassword = await proofRequiresPassword(tagObject);

    if (requiresPassword && !masterPassword) {
        throwRewardIdentityError("ERR_MISSING_PASSWORD");
    }

    try {
        await TagsModule.decryptTag(
            {
                tagName: data.tagName,
                domain: data.domain,
                faceBase64,
                password: masterPassword,
            },
            authUser
        );
    } catch (error) {
        mapOwnershipDecryptError(error);
    }
};

/**
 * Get rewards from IPFS
 * @param {Object} params - Search parameters
 * @param {string} params.zelfName - ZelfName
 * @param {string} params.rewardDate - Reward date
 * @param {string} params.type - Reward type
 * @param {string} params.zelfNameType - ZelfName type
 * @returns {Object} - IPFS data
 */
const get = async (params = {}) => {
    try {
        // Check for composite key optimization first
        const zelfName = params.zelfName || params.userId;
        if (zelfName && params.rewardDate) {
            const rewardPrimaryKey = `${zelfName}${params.rewardDate}`;
            return await IPFS.filter("rewardPrimaryKey", rewardPrimaryKey);
        }

        // Build filters object from params
        const filters = {};

        if (zelfName) filters.zelfName = zelfName;
        if (params.type) filters.rewardType = params.type;
        if (params.rewardDate) filters.rewardDate = params.rewardDate;
        if (params.zelfNameType) filters.zelfNameType = params.zelfNameType;

        // If multiple filters, use multi-key filtering
        if (Object.keys(filters).length > 1) {
            return await _filterByMultipleKeys(filters);
        }

        // Single filter - use direct IPFS filter
        if (zelfName) {
            return await IPFS.filter("zelfName", zelfName);
        }

        if (params.type) {
            return await IPFS.filter("rewardType", params.type);
        }

        if (params.rewardDate) {
            return await IPFS.filter("rewardDate", params.rewardDate);
        }

        // Return empty array if no specific filter
        return [];
    } catch (error) {
        console.error("Error getting rewards from IPFS:", error);
        return [];
    }
};

const show = async (params = {}) => {
    try {
        // Get specific reward by CID
        if (params.cid) return await IPFS.retrieve(params.cid);

        // If ID is provided, try to find it
        if (params.id) return await IPFS.filter("rewardId", params.id);

        return null;
    } catch (error) {
        console.error("Error showing reward from IPFS:", error);
        return null;
    }
};

const create = async (data, authUser) => {
    // For now, just return the request data
    return {
        message: "Reward creation endpoint",
        requestData: data,
        authUser: authUser,
    };
};

const update = async (data, authUser) => {
    // For now, just return the request data
    return {
        message: "Reward update endpoint",
        requestData: data,
        authUser: authUser,
    };
};

const destroy = async (data, authUser) => {
    // For now, just return the request data
    return {
        message: "Reward deletion endpoint",
        requestData: data,
        authUser: authUser,
    };
};

// Helper function to determine ZelfName type
const _getZelfNamePublicData = async (zelfName) => {
    try {
        const searchResult = await ZNSSearchModule.searchZelfName({ key: "zelfName", value: zelfName }, {});

        const zelfNameObject = searchResult.arweave.length ? searchResult.arweave[0] : searchResult.ipfs[0];

        if (!zelfNameObject?.publicData) throw new Error("ZelfName not found");

        return zelfNameObject.publicData;
    } catch (error) {
        throw new Error(`Failed to verify ZelfName: ${error.message}`);
    }
};

/**
 * License override for the daily wheel. A non-empty list of positive finite numbers
 * replaces the default. Anything else keeps `[11..20]` for every name type.
 * @param {Object} [domainConfig]
 * @returns {number[]|null}
 */
const _licenseWheelSegments = (domainConfig) => {
    const raw = domainConfig?.tags?.rewards?.wheelSegments;

    if (!Array.isArray(raw) || raw.length === 0) return null;

    const segments = [];

    for (const value of raw) {
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;

        segments.push(value);
    }

    return segments;
};

// Ten slots, 11–20 ZNS, for every name type unless the license sets `tags.rewards.wheelSegments`.
const _getWheelSegments = (type, domainConfig) => {
    if (type !== "hold" && type !== "mainnet") throw new Error("Invalid ZelfName type");

    return _licenseWheelSegments(domainConfig) || DEFAULT_WHEEL_SEGMENTS.slice();
};

// Uniform index over the wheel. Each segment has the same chance.
const _generateWheelReward = (type, domainConfig) => {
    const segments = _getWheelSegments(type, domainConfig);
    const winningIndex = Math.floor(Math.random() * segments.length);
    const rewardAmount = segments[winningIndex];

    return {
        amount: rewardAmount,
        winningIndex,
        segments,
    };
};

// Get roulette wheel configuration
const getRouletteWheel = async (data, authUser) => {
    try {
        const { tagName, domain } = data;

        const { tagObject, _tagName, domainConfig } = await _getTagObject(tagName, domain, authUser);

        // Last successful claim inside the rolling 24-hour window, including yesterday's key after midnight.
        const todayReward = await _getTodayReward(_tagName);

        const type = tagObject.publicData.type || "hold";
        const segments = _getWheelSegments(type, domainConfig);

        // Check if the user's Solana account is active/funded
        const isAccountActive = await ZNSTokenModule.isAccountActive(tagObject.publicData.solanaAddress);

        const onCooldown = Boolean(todayReward);
        const nextClaimAvailable = onCooldown ? _nextClaimAvailableAt(todayReward) : new Date().toISOString();

        // If user already claimed, extract the reward details
        let todayRewardData = null;

        if (todayReward) {
            // Handle both MongoDB and IPFS data structures
            const amount = todayReward.amount || todayReward.publicData?.amount || 0;
            const claimedAt = todayReward.claimedAt || todayReward.redeemedAt || todayReward.publicData?.redeemedAt || null;

            todayRewardData = {
                amount: parseFloat(amount) || 0,
                currency: "ZNS",
                claimedAt,
                source: todayReward.source || "unknown",
            };
        }

        return {
            success: true,
            tagName: _tagName,
            type,
            segments,
            segmentCount: segments.length,
            canSpin: isAccountActive && !onCooldown,
            alreadyClaimedToday: onCooldown,
            isAccountActive, // Tell frontend if account is active or not
            nextClaimAvailable,
            todayReward: todayRewardData,
        };
    } catch (error) {
        console.error("Error in getRouletteWheel:", error);
        throw new Error(error.message || "Failed to get roulette wheel configuration");
    }
};

// Helper function to filter IPFS files by multiple metadata keys
const _filterByMultipleKeys = async (filters) => {
    try {
        // Start with the first filter to get initial results
        const firstKey = Object.keys(filters)[0];
        let results = await IPFS.filter(firstKey, filters[firstKey]);

        // Apply additional filters by checking metadata
        for (const [key, value] of Object.entries(filters)) {
            if (key === firstKey) continue; // Skip first key as it's already applied

            results = results.filter((file) => file.metadata && file.metadata[key] === value);
        }

        return results;
    } catch (error) {
        console.error("Error filtering by multiple keys:", error);
        return [];
    }
};

const _isStaleDailyProcessing = (record) => {
    if (record?.status !== "processing" || record.payload?.transferSignature) return false;

    const lockedAt = Date.parse(record.payload?.lockedAt || "");

    if (!Number.isFinite(lockedAt)) return true;

    return Date.now() - lockedAt > DAILY_CLAIM_LOCK_STALE_MS;
};

const _releaseDailyClaim = async (record, lockToken, errorMessage) => {
    await Model.updateOne(
        { _id: record._id, status: "processing", "payload.lockToken": lockToken },
        {
            $set: {
                status: "failed",
                payload: {
                    lockToken: null,
                    requiresReconciliation: false,
                    error: errorMessage,
                    winningIndex: record.payload?.winningIndex,
                    segments: record.payload?.segments,
                },
            },
        }
    );
};

const _pinDailyRewardReceipt = async ({ record, tagName, solanaAddress }) => {
    const signature = record.payload?.signature || record.payload?.transferSignature;
    const rewardDate = moment().format("YYYY-MM-DD");
    const redeemedAt = moment().format("YYYY-MM-DD HH:mm:ss");
    const rewardData = {
        rewardsTagName: tagName,
        rewardPrimaryKey: record.rewardPrimaryKey,
        amount: record.amount,
        winningIndex: record.payload?.winningIndex,
        segments: record.payload?.segments,
        type: "daily",
        status: "claimed",
        description: record.description,
        rewardDate,
        redeemedAt,
        zelfNameType: record.zelfNameType,
        tokenTransfer: {
            success: true,
            signature,
            amount: record.amount,
            recipientAddress: solanaAddress,
        },
    };
    const metadata = {
        rewardsTagName: tagName,
        rewardPrimaryKey: record.rewardPrimaryKey,
        rewardType: "daily",
        rewardDate,
        redeemedAt,
        zelfNameType: record.zelfNameType,
        amount: String(record.amount),
        signature: signature || "",
    };

    try {
        const base64Json = Buffer.from(JSON.stringify(rewardData)).toString("base64");
        const filename = `daily-reward-${record.rewardPrimaryKey}.json`;
        const ipfsResult = await IPFS.pinFile(`data:application/json;base64,${base64Json}`, filename, "application/json", metadata);
        const ipfsCid = ipfsResult?.IpfsHash || null;

        if (ipfsCid) {
            await Model.updateOne({ _id: record._id, status: "claimed" }, { $set: { ipfsCid } });
            record.ipfsCid = ipfsCid;
        }

        return ipfsCid;
    } catch (error) {
        console.error("Error storing daily reward receipt:", error?.message || error);
        return record.ipfsCid || null;
    }
};

const _dailyRewardSuccess = ({ record, solanaAddress, ipfsCid, signature }) => {
    const amount = record.amount;
    const transferSignature = signature || record.payload?.signature || record.payload?.transferSignature;
    const claimedAtDate = _claimTime(record) || new Date();

    return {
        success: true,
        message: "Congratulations! You've spun the wheel and won your daily reward!",
        reward: {
            rewardPrimaryKey: record.rewardPrimaryKey,
            amount,
            winningIndex: record.payload?.winningIndex,
            segments: record.payload?.segments,
            currency: "ZNS",
            type: "daily",
            zelfNameType: record.zelfNameType,
            claimedAt: moment(claimedAtDate).format("YYYY-MM-DD HH:mm:ss"),
            nextClaimAvailable: new Date(claimedAtDate.getTime() + DAILY_REWARD_COOLDOWN_MS).toISOString(),
            ipfsCid: ipfsCid || record.ipfsCid || null,
            mongoId: record._id,
            tokenTransfer: {
                success: true,
                signature: transferSignature,
                amount,
                recipientAddress: solanaAddress,
            },
            storage: {
                mongodb: "claimed",
                ipfs: ipfsCid || record.ipfsCid ? "stored" : "pending",
            },
        },
        tokenTransferStatus: "success",
        tokenTransferMessage: `${amount} ZNS tokens have been sent to your Solana address!`,
    };
};

/**
 * A processing claim with a stored signature is settled from that signature.
 * Confirmed payouts become claimed. A transfer that failed or expired releases the day.
 * @param {Object|null} record
 * @returns {Promise<Object|null>}
 */
const _settleProcessingDailyClaim = async (record) => {
    if (!record || record.status !== "processing") return record;

    const signature = record.payload?.transferSignature;

    if (!signature) return record;

    let outcome;

    try {
        outcome = await RewardTransfer.getRewardTransferOutcome({
            signature,
            lastValidBlockHeight: record.payload.lastValidBlockHeight,
        });
    } catch (error) {
        console.error("Daily reward reconciliation failed:", error?.message || error);
        return record;
    }

    if (outcome.state === "confirmed") {
        const saved = await Model.updateOne(
            { _id: record._id, status: "processing", "payload.transferSignature": signature },
            {
                $set: {
                    status: "claimed",
                    redeemedAt: new Date(),
                    "payload.payoutConfirmed": true,
                    "payload.signature": signature,
                    "payload.requiresReconciliation": false,
                    "payload.error": null,
                },
            }
        );

        if (_modifiedCount(saved) !== 1) {
            return (await Model.findOne({ rewardPrimaryKey: record.rewardPrimaryKey })) || record;
        }

        record.status = "claimed";
        record.redeemedAt = new Date();
        record.payload = {
            ...record.payload,
            payoutConfirmed: true,
            signature,
            requiresReconciliation: false,
            error: null,
        };
        record.justConfirmed = true;
        return record;
    }

    if (outcome.state === "failed" || outcome.state === "expired") {
        const saved = await Model.updateOne(
            { _id: record._id, status: "processing", "payload.transferSignature": signature },
            {
                $set: {
                    status: "failed",
                    payload: {
                        lockToken: null,
                        requiresReconciliation: false,
                        error: outcome.state === "expired" ? "reward_transfer_expired" : outcome.error || "reward_transfer_failed",
                        winningIndex: record.payload?.winningIndex,
                        segments: record.payload?.segments,
                    },
                },
            }
        );

        if (_modifiedCount(saved) === 1) {
            record.status = "failed";
            record.payload = {
                lockToken: null,
                requiresReconciliation: false,
                error: outcome.state === "expired" ? "reward_transfer_expired" : outcome.error || "reward_transfer_failed",
                winningIndex: record.payload?.winningIndex,
                segments: record.payload?.segments,
            };
        }
    }

    return record;
};

const _acquireDailyClaim = async (rewardPrimaryKey, fields) => {
    const lockToken = crypto.randomUUID();
    const payload = {
        lockToken,
        lockedAt: new Date().toISOString(),
        requiresReconciliation: false,
        winningIndex: fields.winningIndex,
        segments: fields.segments,
    };
    const expiresAt = _dailyClaimExpiresAt();
    const createdFields = {
        name: fields.name,
        rewardPrimaryKey,
        amount: fields.amount,
        type: "daily",
        status: "processing",
        description: fields.description,
        rewardDate: moment().startOf("day").toDate(),
        zelfNameType: fields.zelfNameType,
        payload,
        expiresAt,
    };

    try {
        return await Model.create(createdFields);
    } catch (error) {
        if (!_isDuplicateKey(error)) throw error;
    }

    const current = await Model.findOne({ rewardPrimaryKey });

    if (!current) throwDailyRewardError(503, DAILY_REWARD_CLAIM_IN_PROGRESS);

    if (current.status === "processing" && current.payload?.transferSignature) {
        throwDailyRewardError(503, DAILY_REWARD_CLAIM_IN_PROGRESS);
    }

    const cooldownElapsed = (current.status === "claimed" || current.payload?.payoutConfirmed) && !_isWithinDailyCooldown(current);
    const failed = current.status === "failed";
    const staleProcessing = current.status === "processing" && !current.payload?.transferSignature && _isStaleDailyProcessing(current);

    if (!failed && !cooldownElapsed && !staleProcessing) {
        if (current.status === "claimed" || current.payload?.payoutConfirmed) _throwDailyCooldown(current);

        throwDailyRewardError(503, DAILY_REWARD_CLAIM_IN_PROGRESS);
    }

    const updated = await Model.findOneAndUpdate(
        {
            _id: current._id,
            status: current.status,
            "payload.lockToken": current.payload?.lockToken ?? null,
        },
        {
            $set: {
                status: "processing",
                amount: fields.amount,
                zelfNameType: fields.zelfNameType,
                description: fields.description,
                payload,
                expiresAt,
            },
        },
        { new: true }
    );

    if (!updated) throwDailyRewardError(503, DAILY_REWARD_CLAIM_IN_PROGRESS);

    return updated;
};

const _loadMongoDailyClaims = async (zelfName) => {
    const records = [];

    for (const rewardPrimaryKey of _dailyRewardLookupKeys(zelfName)) {
        const record = await Model.findOne({ rewardPrimaryKey });

        if (record) records.push(record);
    }

    return records;
};

/** Latest confirmed claim that is still inside the 24-hour window. */
const _blockingClaim = (records, now = Date.now()) => {
    let chosen = null;
    let chosenTime = null;

    for (const record of records) {
        if (!_isWithinDailyCooldown(record, now)) continue;

        const claimTime = _claimTime(record);

        if (!chosen || (claimTime && (!chosenTime || claimTime.getTime() > chosenTime.getTime()))) {
            chosen = record;
            chosenTime = claimTime;
        }
    }

    return chosen;
};

const _inFlightDailyClaim = (records) => records.find((record) => record?.status === "processing" && record.payload?.transferSignature) || null;

/**
 * IPFS is the backup when Mongo no longer has the payout. A receipt blocks only while it is
 * inside 24 hours (or when it has no timestamp, so it cannot be paid again by mistake).
 * @param {string} zelfName
 * @param {number} [now]
 * @returns {Promise<Object|null>}
 */
const _findBlockingReceipt = async (zelfName, now = Date.now()) => {
    for (const rewardPrimaryKey of _dailyRewardLookupKeys(zelfName)) {
        try {
            const receipts = await IPFS.filter("rewardPrimaryKey", rewardPrimaryKey);
            const receipt = Array.isArray(receipts) ? receipts.find(Boolean) : null;

            if (receipt && _isWithinDailyCooldown({ ...receipt, source: "ipfs" }, now)) return receipt;
        } catch (error) {
            if (error?.clientCode) throw error;

            console.error("Daily reward receipt lookup failed:", error?.message || error);
        }
    }

    return null;
};

// Confirmed daily claim that still blocks a new spin. Null once 24 hours have passed.
const _getTodayReward = async (zelfName) => {
    try {
        const records = await _loadMongoDailyClaims(zelfName);
        const blocking = _blockingClaim(records);

        if (blocking) {
            const plain = typeof blocking.toObject === "function" ? blocking.toObject() : blocking;

            return {
                ...plain,
                source: "mongodb",
                metadata: { rewardPrimaryKey: plain.rewardPrimaryKey },
            };
        }

        // A Mongo row already records this payout. Do not let an older receipt extend the window.
        if (records.some(_isConfirmedDailyClaim)) return null;

        const receipt = await _findBlockingReceipt(zelfName);

        if (!receipt) return null;

        return {
            ...receipt,
            source: "ipfs",
        };
    } catch (error) {
        if (error?.clientCode) throw error;

        console.error("Error checking today's reward:", error);
        return null;
    }
};

const _finishConfirmedDailyClaim = async ({ record, tagName, solanaAddress, signature }) => {
    const saved = await Model.updateOne(
        {
            _id: record._id,
            status: "processing",
            "payload.lockToken": record.payload?.lockToken,
            "payload.transferSignature": signature,
        },
        {
            $set: {
                status: "claimed",
                redeemedAt: new Date(),
                "payload.payoutConfirmed": true,
                "payload.signature": signature,
                "payload.requiresReconciliation": false,
                "payload.error": null,
            },
        }
    );

    if (_modifiedCount(saved) !== 1) {
        const current = await Model.findOne({ rewardPrimaryKey: record.rewardPrimaryKey });

        if (current?.status !== "claimed") throwDailyRewardError(503, DAILY_REWARD_CLAIM_IN_PROGRESS);

        record = current;
    } else {
        record.status = "claimed";
        record.payload = {
            ...record.payload,
            payoutConfirmed: true,
            signature,
            requiresReconciliation: false,
            error: null,
        };
    }

    const ipfsCid = await _pinDailyRewardReceipt({ record, tagName, solanaAddress });

    try {
        await _sendRewardNotification(tagName, record.amount, "claimed");
    } catch (error) {
        console.error("Error sending daily reward notification:", error?.message || error);
    }

    return _dailyRewardSuccess({ record, solanaAddress, ipfsCid, signature });
};

const dailyRewards = async (data, authUser) => {
    try {
        const { tagName, domain } = data;

        const { tagObject, _tagName, domainConfig } = await _getTagObject(tagName, domain, authUser);

        await assertDailyRewardIdentity(data, tagObject, authUser);

        const solanaAddress = tagObject?.publicData?.solanaAddress;

        assertPayoutAddressAllowed(solanaAddress);

        // Check if the user's Solana account is active/funded
        const isAccountActive = await ZNSTokenModule.isAccountActive(solanaAddress);

        if (!isAccountActive) {
            return {
                success: false,
                isAccountActive: false,
                message: "Your Solana account is not activated yet. Please deposit some SOL to activate your wallet before spinning the wheel.",
            };
        }

        const rewardPrimaryKey = _dailyRewardSlotKey(_tagName);
        const zelfNameType = tagObject.publicData.type;

        let inFlight = _inFlightDailyClaim(await _loadMongoDailyClaims(_tagName));

        if (inFlight) {
            inFlight = await _settleProcessingDailyClaim(inFlight);

            if (inFlight?.justConfirmed) {
                const ipfsCid = await _pinDailyRewardReceipt({ record: inFlight, tagName: _tagName, solanaAddress });

                return _dailyRewardSuccess({ record: inFlight, solanaAddress, ipfsCid, signature: inFlight.payload?.signature });
            }

            if (inFlight?.status === "processing" && inFlight.payload?.transferSignature) {
                throwDailyRewardError(503, DAILY_REWARD_CLAIM_IN_PROGRESS);
            }
        }

        const openClaims = await _loadMongoDailyClaims(_tagName);
        const blocking = _blockingClaim(openClaims);

        if (blocking) _throwDailyCooldown(blocking);

        // Mongo rows expire. A receipt younger than 24 hours means the payout was confirmed.
        if (!openClaims.some(_isConfirmedDailyClaim)) {
            const receipt = await _findBlockingReceipt(_tagName);

            if (receipt) _throwDailyCooldown({ ...receipt, source: "ipfs" });
        }

        const wheelResult = _generateWheelReward(zelfNameType, domainConfig);
        const description = `Daily wheel reward for ${zelfNameType} ZelfName`;

        let record = await _acquireDailyClaim(rewardPrimaryKey, {
            name: _tagName,
            amount: wheelResult.amount,
            winningIndex: wheelResult.winningIndex,
            segments: wheelResult.segments,
            zelfNameType,
            description,
        });

        const lockToken = record.payload?.lockToken;
        let storedSignature = null;
        let transfer;

        try {
            transfer = await RewardTransfer.sendRewardTransfer(wheelResult.amount, solanaAddress, {
                onSigned: async ({ signature, lastValidBlockHeight }) => {
                    const stored = await Model.updateOne(
                        { _id: record._id, status: "processing", "payload.lockToken": lockToken },
                        {
                            $set: {
                                "payload.transferSignature": signature,
                                "payload.lastValidBlockHeight": lastValidBlockHeight,
                                "payload.requiresReconciliation": true,
                            },
                        }
                    );

                    if (_modifiedCount(stored) !== 1) throw new Error("reward_reservation_lost");

                    storedSignature = signature;
                },
            });
        } catch (error) {
            if (storedSignature || error?.message === "reward_reservation_lost") {
                throwDailyRewardError(503, DAILY_REWARD_CLAIM_IN_PROGRESS);
            }

            console.error("Daily reward payout was not sent:", error?.message || error);

            try {
                await _releaseDailyClaim(record, lockToken, error?.message || "reward_transfer_not_sent");
            } catch (releaseError) {
                console.error("Daily reward lock release failed:", releaseError?.message || releaseError);
            }

            throwDailyRewardError(502, DAILY_REWARD_PAYOUT_FAILED);
        }

        if (transfer.state === "failed") {
            console.error("Daily reward payout failed:", transfer.signature, transfer.error || "");

            try {
                await _releaseDailyClaim(record, lockToken, transfer.error || "reward_transfer_failed");
            } catch (releaseError) {
                console.error("Daily reward lock release failed:", releaseError?.message || releaseError);
            }

            throwDailyRewardError(502, DAILY_REWARD_PAYOUT_FAILED);
        }

        if (transfer.state !== "confirmed") throwDailyRewardError(503, DAILY_REWARD_CLAIM_IN_PROGRESS);

        return _finishConfirmedDailyClaim({
            record,
            tagName: _tagName,
            solanaAddress,
            signature: transfer.signature,
        });
    } catch (error) {
        if (isRewardIdentityError(error) || isPayoutAddressBlockedError(error) || error?.clientCode) throw error;

        console.error("Error in dailyRewards:", safeRewardErrorText(error));
        throw new Error(error.message || "Failed to process daily reward");
    }
};

// Notification system placeholder functions
const _sendRewardNotification = async (zelfName, amount, status) => {
    // TODO: Implement notification system
};

const _sendDailyReminderNotification = async (zelfName) => {
    // TODO: Implement daily reminder notification
};

const _sendWeeklyRewardSummary = async (zelfName, weeklyTotal) => {
    // TODO: Implement weekly summary notification
};

// Function to check and send reminder notifications (for cron job)
const checkAndSendReminders = async () => {
    // TODO: Implement logic to find users who haven't claimed today
    // and send them reminder notifications
};

// Get user's reward history
const getUserRewardHistory = async (tagName, domain, limit = 10) => {
    // Normalize zelfName
    const _tagName = TagsPartsModule.getFullTagName(tagName, domain);

    // Get all reward files for this user from IPFS
    const ipfsFiles = await IPFS.filter("rewardsTagName", _tagName);

    // Parse and sort rewards by date
    const rewards = [];
    let totalEarned = 0;

    for (const file of ipfsFiles) {
        if (!file.publicData.rewardType) continue;

        // Use the metadata directly - no need to fetch URLs
        rewards.push({
            ipfsCid: file.ipfs_pin_hash,
            publicData: file.publicData,
            amount: parseFloat(file.publicData.amount) || 0,
            rewardType: file.publicData.rewardType,
            rewardDate: file.publicData.rewardDate,
            claimedAt: file.publicData.redeemedAt || file.publicData.rewardDate,
            status: "claimed", // All stored rewards are claimed
        });

        if (file.publicData.amount) {
            totalEarned += parseFloat(file.publicData.amount) || 0;
        }
    }

    // Sort by claimedAt date (newest first) and limit
    const sortedRewards = rewards.sort((a, b) => new Date(b.claimedAt) - new Date(a.claimedAt)).slice(0, limit);

    return {
        rewards: sortedRewards,
        totalEarned,
        rewardsCount: rewards.length,
    };
};

// Get user's reward statistics
const getUserRewardStats = async (tagName, domain) => {
    try {
        const now = moment();
        const startOfWeek = moment().startOf("week").toDate();
        const startOfMonth = moment().startOf("month").toDate();

        const [dailyStreak, weeklyTotal, monthlyTotal, activeClaim] = await Promise.all([
            _calculateDailyStreak(tagName, domain),
            _getTotalRewardsInPeriod(tagName, domain, startOfWeek),
            _getTotalRewardsInPeriod(tagName, domain, startOfMonth),
            _getTodayReward(tagName),
        ]);

        return {
            dailyStreak,
            weeklyTotal,
            monthlyTotal,
            canClaimToday: !activeClaim,
            nextClaimAvailable: activeClaim ? _nextClaimAvailableAt(activeClaim) : new Date().toISOString(),
        };
    } catch (error) {
        throw new Error(`Failed to get reward stats: ${error.message}`);
    }
};

// Helper function to calculate daily streak
const _calculateDailyStreak = async (tagName, domain) => {
    try {
        // Normalize zelfName
        const _tagName = TagsPartsModule.getFullTagName(tagName, domain);

        // Get all daily rewards for this user
        const ipfsFiles = await IPFS.filter("rewardsTagName", _tagName);

        const dailyRewards = [];

        // Filter for daily rewards and parse dates
        for (const file of ipfsFiles) {
            if (file.publicData.rewardType === "daily") {
                dailyRewards.push({
                    date: moment(file.publicData.rewardDate, "YYYY-MM-DD"),
                    metadata: file.publicData,
                });
            }
        }

        if (dailyRewards.length === 0) return 0;

        // Sort by date (newest first)
        dailyRewards.sort((a, b) => b.date.valueOf() - a.date.valueOf());

        let streak = 0;
        let currentDate = moment().startOf("day");

        for (const reward of dailyRewards) {
            if (reward.date.isSame(currentDate)) {
                streak++;
                currentDate.subtract(1, "day");
            } else if (reward.date.isSame(currentDate.subtract(1, "day"))) {
                streak++;
                currentDate.subtract(1, "day");
            } else {
                break;
            }
        }

        return streak;
    } catch (error) {
        console.error("Error calculating streak:", error);
        return 0;
    }
};

// Helper function to get total rewards in a period
const _getTotalRewardsInPeriod = async (zelfName, startDate) => {
    try {
        // Normalize zelfName
        const normalizedZelfName = normalizeZelfName(zelfName);

        // Get all rewards for this user
        const ipfsFiles = await IPFS.filter("rewardsTagName", normalizedZelfName);
        let total = 0;

        const startMoment = moment(startDate);

        for (const file of ipfsFiles) {
            if (file.publicData.rewardDate) {
                const rewardDate = moment(file.publicData.rewardDate, "YYYY-MM-DD");

                // Check if reward is within the period
                if (rewardDate.isSameOrAfter(startMoment)) {
                    const amount = parseFloat(file.publicData.amount) || 0;
                    total += amount;
                }
            }
        }

        return total;
    } catch (error) {
        console.error("Error calculating period total:", error);
        return 0;
    }
};

const _getTagObject = async (tagName, domain, authUser) => {
    const domainConfig = getDomainConfig(domain);

    const tagResult = await TagsSearchModule.searchTag(
        {
            tagName,
            domain,
            domainConfig,
            environment: "all",
            type: "both",
        },
        authUser
    );

    if (!tagResult.tagObject) {
        console.log({ tagName, domain });
        throw new Error("404:tag_not_found");
    }

    const tagObject = tagResult.tagObject;

    // Validate that user has a Solana address for token transfer
    if (!tagObject.publicData.solanaAddress) throw new Error("409:no_solana_address_found");

    const _tagName = TagsPartsModule.getTagNameFromPublicData(tagObject, "full", domainConfig);

    return { tagObject, _tagName, domainConfig };
};

/**
 * The rewarded name is the session's stored verifiedTagName.
 * A client-supplied tagName that does not match that record is rejected.
 */
const resolveVerifiedRewardTarget = async (data, authUser) => {
    const Session = require("../../Session/models/session.model");
    const { normalizeZelfName } = require("../../Tags/modules/zelf-name.util");

    if (!authUser?.session) throwRewardIdentityError("ERR_IDENTITY_VERIFICATION_REQUIRED");

    const session = await Session.findById(authUser.session).lean();
    const verifiedUntil = session?.verifiedUntil ? new Date(session.verifiedUntil).getTime() : 0;
    const verifiedRaw = typeof session?.verifiedTagName === "string" ? session.verifiedTagName.trim() : "";

    if (!session || session.status !== "active" || !verifiedRaw || !Number.isFinite(verifiedUntil) || verifiedUntil <= Date.now()) {
        throwRewardIdentityError("ERR_IDENTITY_VERIFICATION_REQUIRED");
    }

    const domain = data?.domain || session.domain || authUser.domain || "zelf";
    const verified = normalizeZelfName(verifiedRaw, session.domain || domain);
    const requested = normalizeZelfName(data?.tagName, data?.domain || domain);

    if (!verified.zelfName || !requested.zelfName || verified.zelfName !== requested.zelfName) {
        throwRewardIdentityError("ERR_SESSION_OWNER_MISMATCH");
    }

    return {
        ...data,
        tagName: verified.tagName,
        domain: verified.domain,
    };
};

const rewardFirstTransaction = async (data, authUser) => {
    try {
        const owned = await resolveVerifiedRewardTarget(data, authUser);
        const { tagName, domain } = owned;

        const { tagObject, _tagName, domainConfig } = await _getTagObject(tagName, domain, authUser);

        await assertDailyRewardIdentity(owned, tagObject, authUser);

        // Check if user has already received first transaction reward
        const existingReward = await IPFS.filter("first_zns_transaction", _tagName);

        const hasFirstTransactionReward = existingReward.length > 0;

        if (hasFirstTransactionReward) {
            const claimedAmount = existingReward[0]?.publicData?.amount || 0;
            return {
                success: false,
                message: "First transaction reward already claimed",
                rewardType: "first_transaction",
                alreadyClaimed: true,
                reward: { amount: parseFloat(claimedAmount), currency: "ZNS" },
            };
        }

        // Check if user has sent ZNS tokens (indicating they've used the token)
        const sentTokenCheck = await ZNSTransactionDetector.hasSentZNSTokens(
            tagObject.publicData.solanaAddress,
            { hours: 24 * 365, minAmount: 0.001 } // Check last year, any amount
        );

        if (!sentTokenCheck.hasSent) {
            return {
                success: false,
                message: "No ZNS token transactions found. Make your first ZNS transaction to earn this reward!",
                rewardType: "first_transaction",
                eligible: false,
                requirements: {
                    action: "Send ZNS tokens",
                    description: "Make your first ZNS token transaction to unlock this reward",
                },
            };
        }

        assertPayoutAddressAllowed(tagObject?.publicData?.solanaAddress);

        // User is eligible for first transaction reward - random 1-100 ZNS
        const rewardAmount = Math.floor(Math.random() * 100) + 1;
        const rewardType = "first_transaction";
        const rewardDate = moment().format("YYYY-MM-DD");

        // Create reward data
        const rewardData = {
            tagName: _tagName,
            amount: rewardAmount,
            rewardType,
            rewardDate,
            description: "First ZNS Transaction Reward",
            requirements: {
                action: "Sent ZNS tokens",
                transactionCount: sentTokenCheck.transactionCount,
                totalAmountSent: sentTokenCheck.totalAmountSent,
                lastTransaction: sentTokenCheck.lastTransaction?.signature,
            },
            timestamp: new Date().toISOString(),
        };

        // Save to IPFS with specific filter key for first ZNS transaction
        const rewardJson = JSON.stringify(rewardData);
        const base64Json = Buffer.from(rewardJson).toString("base64");
        const filename = `first-zns-transaction-${_tagName}.json`;

        // Metadata for IPFS querying with specific filter key
        const metadata = {
            first_zns_transaction: _tagName, // Specific filter key for easy searching
            rewardsTagName: _tagName,
            rewardType: "first_transaction",
            amount: rewardAmount.toString(),
            description: "First ZNS Transaction Reward",
            solanaAddress: tagObject.publicData.solanaAddress,
            rewardDate: moment().format("YYYY-MM-DD"),
            redeemedAt: moment().format("YYYY-MM-DD HH:mm:ss"),
        };

        const ipfsResult = await IPFS.pinFile(`data:application/json;base64,${base64Json}`, filename, "application/json", metadata);
        rewardData.ipfsHash = ipfsResult.IpfsHash;

        // Save to MongoDB

        const mongoReward = new Model({
            name: _tagName,
            rewardPrimaryKey: `first_transaction_${_tagName}`,
            amount: rewardAmount,
            type: "achievement", // Using achievement type for first transaction
            status: "claimed",
            description: "First ZNS Transaction Reward",
            rewardDate: moment().format("YYYY-MM-DD"),
            redeemedAt: moment().format("YYYY-MM-DD HH:mm:ss"),
            zelfNameType: tagObject.publicData.type || "hold", // Get from public data
            ipfsCid: ipfsResult.IpfsHash,
            metadata: rewardData,
        });

        await mongoReward.save();

        // Send ZNS tokens to user
        let tokenTransferResult = null;
        let tokenTransferError = null;

        try {
            const transferSignature = await ZNSTokenModule.giveTokensAfterPurchase(rewardAmount, tagObject.publicData.solanaAddress);

            tokenTransferResult = {
                success: true,
                signature: transferSignature,
                amount: rewardAmount,
                recipientAddress: tagObject.publicData.solanaAddress,
            };

            rewardData.tokenTransfer = tokenTransferResult;
            mongoReward.tokenTransfer = tokenTransferResult;
            mongoReward.status = "claimed";
            await mongoReward.save();
        } catch (tokenError) {
            console.error("❌ Failed to send first transaction reward:", tokenError);
            tokenTransferError = {
                success: false,
                error: tokenError.message,
                amount: rewardAmount,
                recipientAddress: tagObject.publicData.solanaAddress,
            };

            rewardData.tokenTransfer = tokenTransferError;
            mongoReward.tokenTransfer = tokenTransferError;
            mongoReward.status = "failed";
            mongoReward.failReason = tokenError.message;
            await mongoReward.save();
        }

        // Send notification
        await _sendRewardNotification(_tagName, rewardAmount, tokenTransferResult ? "success" : "failed");

        return {
            success: true,
            message: "First transaction reward claimed successfully!",
            reward: {
                amount: rewardAmount,
                rewardType,
                tagName: _tagName,
                description: "First ZNS Transaction Reward",
                requirements: rewardData.requirements,
            },
            tokenTransfer: tokenTransferResult || tokenTransferError,
            tokenTransferStatus: tokenTransferResult ? "success" : "failed",
            ipfsHash: ipfsResult.hash,
            timestamp: rewardData.timestamp,
        };
    } catch (error) {
        if (isRewardIdentityError(error) || isPayoutAddressBlockedError(error)) throw error;

        console.error("❌ Error in rewardFirstTransaction:", error);
        throw new Error(`Failed to process first transaction reward: ${error.message}`);
    }
};

module.exports = {
    get,
    show,
    create,
    update,
    destroy,
    dailyRewards,
    getRouletteWheel,
    rewardFirstTransaction,
    checkAndSendReminders,
    getUserRewardHistory,
    getUserRewardStats,
};
