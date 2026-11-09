/**
 * Shared referral-cap lookup. Signup, checkout, the public availability check, and
 * reward claims all read this so "spots remaining" and "counts for reward" stay the same.
 */
const TagsSearchModule = require("./tags-search.module");
const { getDomainConfig, loadDynamicDomains } = require("../config/supported-domains");
const ReferralRewardModel = require("../models/referral-rewards.model");
const { codedError } = require("../../../Core/http-handler");
const {
    referralName,
    groupReferralRecords,
    referralRewardLimit,
    referralCapacity,
    canonicalReferralTagName,
} = require("./referral-reward.util");

/**
 * Domain config for referral reads. Waits for the license cache when it is empty so a
 * cold worker does not treat storage as disabled and report zero referrals.
 * @param {string} domain
 * @returns {Promise<Object>}
 */
const requireReferralDomainConfig = async (domain) => {
    const name = String(domain || "")
        .replace(/^\./, "")
        .trim()
        .toLowerCase();

    if (!name) throw new Error("400:domain_not_supported");

    const cached = getDomainConfig(name);

    if (cached) return cached;

    let loaded = null;

    try {
        loaded = await loadDynamicDomains(null, false);
    } catch (error) {
        console.error("Referral domain config reload failed:", error?.message || error);
    }

    const domainConfig = getDomainConfig(name);

    if (domainConfig) return domainConfig;

    if (loaded && Object.keys(loaded).length) throw new Error("400:domain_not_supported");

    const err = new Error("domain_config_unavailable");
    err.status = 503;
    err.code = "domain_config_unavailable";
    throw err;
};

/** Friends (canonical names) that already have a reward paid or in flight for this referrer. */
const rewardedReferralFriends = async (referralTagName) => {
    const records = await ReferralRewardModel.find(
        { referralTagName, status: { $in: ["pending", "processing", "completed"] } },
        { tagName: 1, domain: 1 }
    );
    return new Set(
        (Array.isArray(records) ? records : []).map((record) => {
            const name = referralName(record.tagName);
            return name.includes(".") ? name : `${name}.${record.domain || "zelf"}`;
        })
    );
};

const loadReferralRecords = async (referralTagName, domain, domainConfig, authUser = {}) => {
    const [ipfsRecords, arweaveRecords] = await Promise.all([
        TagsSearchModule.searchIPFS(
            {
                key: "referralTagName",
                value: referralTagName,
                domain,
                domainConfig,
            },
            authUser
        ),
        TagsSearchModule.searchArweave(
            {
                key: "referralTagName",
                value: referralTagName,
                domain,
                domainConfig,
            },
            authUser
        ),
    ]);

    return [...ipfsRecords, ...arweaveRecords];
};

const capacityForReferrer = async (referralTagName, domain, domainConfig, authUser = {}) => {
    const fullName = canonicalReferralTagName(referralTagName, domain || domainConfig?.name);
    const records = await loadReferralRecords(fullName, domain || domainConfig?.name, domainConfig, authUser);
    const rewarded = await rewardedReferralFriends(fullName);
    return referralCapacity(groupReferralRecords(records), rewarded, referralRewardLimit());
};

/** The referral key that a new friend's record would store for this inviter. */
const canonicalNameFromReferrer = (tagObject, domainConfig) => {
    const storageKey = domainConfig?.getTagKey?.() || "tagName";
    const stored = tagObject?.publicData?.[storageKey] || tagObject?.publicData?.tagName || tagObject?.publicData?.zelfName || "";
    return canonicalReferralTagName(stored, domainConfig?.name);
};

/**
 * Reject a new registration or checkout referral once the inviter is at the reward cap.
 * Existing stored referrals are left alone; callers skip this for recovery.
 * @param {Object} tagObject referrer record from `_validateReferral`
 * @param {Object} domainConfig
 */
const assertReferrerAcceptsNewReferral = async (tagObject, domainConfig) => {
    if (!tagObject || !domainConfig) return;

    const referralTagName = canonicalNameFromReferrer(tagObject, domainConfig);

    if (!referralTagName) return;

    const capacity = await capacityForReferrer(referralTagName, domainConfig.name, domainConfig, {});

    if (!capacity.acceptsNewReferrals) throw codedError("409:REFERRAL_LIMIT_REACHED");
};

/**
 * Public summary. Only the four fields the apps need before signup.
 * @param {string} referralTagName
 * @param {Object} domainConfig
 * @param {boolean} exists
 */
const publicReferralAvailability = async (referralTagName, domainConfig, exists) => {
    const limit = referralRewardLimit();

    if (!exists) {
        return { exists: false, limit, spotsRemaining: 0, acceptsNewReferrals: false };
    }

    const capacity = await capacityForReferrer(referralTagName, domainConfig.name, domainConfig, {});

    return {
        exists: true,
        limit: capacity.limit,
        spotsRemaining: capacity.spotsRemaining,
        acceptsNewReferrals: capacity.acceptsNewReferrals,
    };
};

module.exports = {
    requireReferralDomainConfig,
    rewardedReferralFriends,
    loadReferralRecords,
    capacityForReferrer,
    canonicalNameFromReferrer,
    assertReferrerAcceptsNewReferral,
    publicReferralAvailability,
};
