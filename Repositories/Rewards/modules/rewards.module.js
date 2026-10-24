const IPFS = require("../../../Core/ipfs");
const ZNSSearchModule = require("../../ZelfNameService/modules/zns-search.module");
const ZNSTokenModule = require("../../ZelfNameService/modules/zns-token.module");
const NotificationService = require("../services/notification.service");
const Model = require("../models/rewards.model"); // MongoDB model for TTL cache
const moment = require("moment");
const ZNSTransactionDetector = require("../../ZelfNameService/modules/zns-transaction-detector.module");
const { normalizeZelfName } = require("../middlewares/rewards.middleware");
const TagsSearchModule = require("../../Tags/modules/tags-search.module");
const { getDomainConfig } = require("../../Tags/config/supported-domains");
const TagsPartsModule = require("../../Tags/modules/tags-parts.module");
const TagsModule = require("../../Tags/modules/tags.module");
const ZelfProofModule = require("../../ZelfProof/modules/zelf-proof.module");
const { isNoPassword } = require("../../ZelfID/modules/zelf-id-password.module");

/** Client codes for daily-reward identity checks. Statuses match Zelf Keys ownership decrypt. */
const REWARD_IDENTITY_STATUS = {
    ERR_IDENTITY_VERIFICATION_REQUIRED: 400,
    ERR_MISSING_PASSWORD: 400,
    ERR_INVALID_PASSWORD: 401,
    ERR_PASSWORD_REQUIRED: 409,
    ERR_VERIFICATION_FAILED: 422,
};

const throwRewardIdentityError = (code) => {
    const status = REWARD_IDENTITY_STATUS[code] || 422;
    const error = new Error(`${status}:${code}`);

    error.status = status;
    error.code = code;

    throw error;
};

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

// Helper function to get wheel segments based on type
const _getWheelSegments = (type) => {
    if (type === "hold") {
        // .hold domains: 1 to 12 ZNS (12 slots)
        return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    } else if (type === "mainnet") {
        // Purchased domains (mainnet): 2, 4, 6, ... 24 ZNS (12 slots, even numbers)
        return [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24];
    } else {
        throw new Error("Invalid ZelfName type");
    }
};

// Helper function to generate wheel reward based on type
const _generateWheelReward = (type) => {
    const segments = _getWheelSegments(type);

    // Select a random segment index
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

        // Check if user already claimed today
        const todayReward = await _getTodayReward(_tagName);

        const type = tagObject.publicData.type || "hold";
        const segments = _getWheelSegments(type);

        // Check if the user's Solana account is active/funded
        const isAccountActive = await ZNSTokenModule.isAccountActive(tagObject.publicData.solanaAddress);

        // Calculate next claim time (tomorrow at midnight UTC)
        const nextClaimAvailable = moment().add(1, "day").startOf("day").toISOString();

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
            canSpin: isAccountActive && !todayReward,
            alreadyClaimedToday: !!todayReward,
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

// Helper function to check if user already claimed today
const _getTodayReward = async (zelfName) => {
    try {
        // Create composite key for direct lookup
        const todayKey = moment().format("YYYY-MM-DD");

        const rewardPrimaryKey = `${zelfName}${todayKey}`;

        // Step 1: Check MongoDB first (TTL cache for first 5 minutes)
        const mongoReward = await Model.findOne({ rewardPrimaryKey });
        if (mongoReward) {
            // FIX: If status is failed, allow retry (return null)
            if (mongoReward.status === "failed") return null;

            return {
                ...mongoReward.toObject(),
                source: "mongodb",
                metadata: { rewardPrimaryKey },
            };
        }

        // Step 2: If not in MongoDB, check IPFS (after 5 minutes)
        const ipfsRewards = await IPFS.filter("rewardPrimaryKey", rewardPrimaryKey);

        if (ipfsRewards && ipfsRewards[0]) {
            return {
                ...ipfsRewards[0],
                source: "ipfs",
            };
        }

        return null;
    } catch (error) {
        console.error("Error checking today's reward:", error);
        return null;
    }
};

const dailyRewards = async (data, authUser) => {
    try {
        const { tagName, domain } = data;

        const { tagObject, _tagName, domainConfig } = await _getTagObject(tagName, domain, authUser);

        await assertDailyRewardIdentity(data, tagObject, authUser);

        // Check if the user's Solana account is active/funded
        const isAccountActive = await ZNSTokenModule.isAccountActive(tagObject.publicData.solanaAddress);

        if (!isAccountActive) {
            return {
                success: false,
                isAccountActive: false,
                message: "Your Solana account is not activated yet. Please deposit some SOL to activate your wallet before spinning the wheel.",
            };
        }

        // Check if user already claimed today
        const todayReward = await _getTodayReward(_tagName);

        if (todayReward) {
            return {
                success: false,
                reward: todayReward,
                message: "You have already claimed your daily reward today. Come back tomorrow!",
                nextClaimAvailable: moment().add(1, "day").startOf("day").toISOString(),
            };
        }

        // Generate wheel reward based on type
        const wheelResult = _generateWheelReward(tagObject.publicData.type);
        const rewardAmount = wheelResult.amount;

        const todayKey = moment().format("YYYY-MM-DD");
        const rewardPrimaryKey = `${_tagName}${todayKey}`;
        // Create reward data
        const rewardData = {
            rewardsTagName: _tagName,
            rewardPrimaryKey,
            amount: rewardAmount,
            winningIndex: wheelResult.winningIndex,
            segments: wheelResult.segments,
            type: "daily",
            status: "claimed",
            description: `Daily wheel reward for ${tagObject.publicData.type} ZelfName`,
            rewardDate: moment().format("YYYY-MM-DD"),
            redeemedAt: moment().format("YYYY-MM-DD HH:mm:ss"),
            zelfNameType: tagObject.publicData.type,
            wheelSpin: true,
            rewardRange: tagObject.publicData.type === "hold" ? "1-12" : "2-24",
        };

        // Metadata for IPFS querying (key-value pairs)
        const metadata = {
            rewardsTagName: _tagName,
            rewardPrimaryKey, // Composite key for direct lookup
            rewardType: "daily",
            rewardDate: moment().format("YYYY-MM-DD"), // Date without time for easy querying
            redeemedAt: moment().format("YYYY-MM-DD HH:mm:ss"), // Exact timestamp when redeemed
            zelfNameType: tagObject.publicData.type,
            amount: rewardAmount.toString(),
        };

        // Store reward as JSON in IPFS
        const rewardJson = JSON.stringify(rewardData);
        const base64Json = Buffer.from(rewardJson).toString("base64");
        const filename = `daily-reward-${rewardPrimaryKey}.json`;

        // FIX: Remove any existing "failed" record to avoid duplicate key error on unique index
        await Model.deleteOne({ rewardPrimaryKey, status: "failed" });

        // Step 1: Save to MongoDB with TTL (5 minutes) for immediate availability
        const mongoReward = new Model({
            name: _tagName,
            rewardPrimaryKey,
            amount: rewardAmount,
            type: "daily",
            status: "claimed",
            description: `Daily wheel reward for ${tagObject.publicData.type} ZelfName`,
            claimedAt: new Date(),
            zelfNameType: tagObject.publicData.type,
            metadata: {
                wheelSpin: true,
                rewardRange: tagObject.publicData.type === "hold" ? "0.1-1.0" : "0.2-2.0",
            },
        });

        await mongoReward.save();

        // Step 2: Save to IPFS for permanent storage (async, non-blocking)
        const ipfsResult = await IPFS.pinFile(`data:application/json;base64,${base64Json}`, filename, "application/json", metadata);

        if (ipfsResult) {
            // Update MongoDB record with IPFS CID
            mongoReward.ipfsCid = ipfsResult.IpfsHash;
            await mongoReward.save();
        }

        // Trigger notification
        await _sendRewardNotification(_tagName, rewardAmount, "claimed");

        // Step 3: Send ZNS tokens to user's Solana address
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

            // Update reward status to include token transfer success
            rewardData.tokenTransfer = tokenTransferResult;
            mongoReward.tokenTransfer = tokenTransferResult;
            await mongoReward.save();
        } catch (tokenError) {
            console.error("Failed to send ZNS tokens:", tokenError);

            tokenTransferError = {
                success: false,
                error: tokenError.message,
                amount: rewardAmount,
                recipientAddress: tagObject.publicData.solanaAddress,
            };

            // Update reward status to include token transfer failure
            // FIX: Update status to failed so user can try again
            rewardData.tokenTransfer = tokenTransferError;
            mongoReward.tokenTransfer = tokenTransferError;
            mongoReward.tokenTransferStatus = "failed";
            mongoReward.status = "failed"; // Mark as failed in DB

            // FIX: Remove IPFS CID reference since we are going to unpin it
            mongoReward.ipfsCid = null;
            await mongoReward.save();

            // FIX: Unpin from IPFS so it doesn't show up in future checks
            if (ipfsResult && ipfsResult.IpfsHash) {
                try {
                    console.log(`Unpinning failed reward from IPFS: ${ipfsResult.IpfsHash}`);
                    await IPFS.unPinFiles([ipfsResult.IpfsHash]);
                } catch (unpinError) {
                    console.error("Failed to unpin IPFS file:", unpinError);
                }
            }

            // FIX: Return success: false so frontend shows error instead of claimed
            return {
                success: false,
                message: `Failed to transfer tokens: ${tokenError.message}. Please try again later.`,
                tokenTransferStatus: "failed",
                tokenTransferMessage: tokenError.message,
            };
        }

        return {
            success: true,
            message: "Congratulations! You've spun the wheel and won your daily reward!",
            reward: {
                rewardPrimaryKey,
                amount: rewardAmount,
                winningIndex: wheelResult.winningIndex,
                segments: wheelResult.segments,
                currency: "ZNS",
                type: "daily",
                zelfNameType: tagObject.publicData.type,
                claimedAt: rewardData.claimedAt,
                nextClaimAvailable: moment().add(1, "day").startOf("day").toISOString(),
                ipfsCid: ipfsResult?.IpfsHash || null,
                mongoId: mongoReward._id,
                tokenTransfer: tokenTransferResult || tokenTransferError,
                storage: {
                    mongodb: "immediate (5min TTL)",
                    ipfs: ipfsResult ? "stored" : "failed",
                },
            },
            tokenTransferStatus: tokenTransferResult ? "success" : "failed",
            tokenTransferMessage: tokenTransferResult
                ? `${rewardAmount} ZNS tokens have been sent to your Solana address!`
                : `Reward claimed but token transfer failed. Please contact support with error: ${tokenTransferError?.error}`,
        };
    } catch (error) {
        if (isRewardIdentityError(error)) throw error;

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

        const [dailyStreak, weeklyTotal, monthlyTotal, canClaimToday] = await Promise.all([
            _calculateDailyStreak(tagName, domain),
            _getTotalRewardsInPeriod(tagName, domain, startOfWeek),
            _getTotalRewardsInPeriod(tagName, domain, startOfMonth),
            _hasClaimedToday(tagName, domain),
        ]);

        return {
            dailyStreak,
            weeklyTotal,
            monthlyTotal,
            canClaimToday: !canClaimToday,
            nextClaimAvailable: canClaimToday ? moment().add(1, "day").startOf("day").toISOString() : moment().toISOString(),
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

// Helper function to check if user has claimed today
const _hasClaimedToday = async (tagName, domain) => {
    try {
        const todayReward = await _getTodayReward(tagName);

        return todayReward !== null;
    } catch (error) {
        console.error("Error checking if user claimed today:", error);
        return false;
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

const rewardFirstTransaction = async (data, authUser) => {
    try {
        const { tagName, domain } = data;

        const { tagObject, _tagName, domainConfig } = await _getTagObject(tagName, domain, authUser);

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
