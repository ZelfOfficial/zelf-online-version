/** Canonical wallet identity is independent of a reservation's `.hold` suffix. */
const referralName = (name) =>
    String(name || "")
        .trim()
        .toLowerCase()
        .replace(/\.hold$/, "");
const recordReferralName = (record) => referralName(record.publicData?.tagName || record.publicData?.zelfName || record.name || record.tagName);

// Older receipts omitted the domain for registration. Check both formats before
// paying, but write the fully qualified key so different domains cannot collide.
const rewardFriendKeys = (name, rewardType) => {
    const fullName = referralName(name);
    return rewardType === "registration" ? [...new Set([`${fullName}.hold`, `${fullName.split(".")[0]}.hold`])] : [fullName];
};

const findReferralRecord = (records, name, rewardType) => {
    const expected = referralName(name);
    const matches = records.filter((record) => recordReferralName(record) === expected);
    if (rewardType === "registration") return matches.find((record) => record.publicData?.type === "hold") || matches[0];
    return matches.find((record) => record.publicData?.type === "mainnet");
};

const groupReferralRecords = (records) => {
    const wallets = new Map();
    for (const record of records) {
        const name = recordReferralName(record);
        if (!name) continue;
        if (!wallets.has(name) || record.publicData?.type === "mainnet") wallets.set(name, record);
    }
    return wallets;
};

const explicitReferralPrice = (record) => {
    const data = record.publicData || {};
    const extra = record.metadata?.extraParams || {};
    if ((data.plan || extra.plan) === "free") return 0;
    const price = data.price ?? extra.price;
    if (price === undefined || price === null || price === "") return null;
    const value = Number(price);
    return Number.isFinite(value) && value >= 0 ? value : 0;
};

/** Referrals that count toward the reward. Existing extras stay as history; new signups are rejected once this is full. */
const DEFAULT_REFERRAL_REWARD_LIMIT = 10;
const referralRewardLimit = (value = process.env.REFERRAL_REWARD_LIMIT) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : DEFAULT_REFERRAL_REWARD_LIMIT;
};

const _recordTime = (record) => {
    const raw = record?.publicData?.registeredAt || record?.date_pinned || record?.created_at || record?.publicData?.createdAt;
    const t = raw ? Date.parse(String(raw).replace(" ", "T")) : NaN;
    return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
};

/** Slots left after rewarded friends that are not in this domain's referral list. */
const effectiveReferralLimit = (friends, rewarded, limit) => {
    const externalRewardedCount = [...rewarded].filter((name) => !friends.has(name)).length;
    return Math.max(0, limit - externalRewardedCount);
};

/**
 * Pick which friends count toward the reward: friends already rewarded first, then the earliest
 * referrals until `limit`. Everything else is history (no reward).
 * @param {Map<string, Object>} friends name -> referral record
 * @param {Set<string>} rewarded names already rewarded/being rewarded
 * @param {number} limit
 * @returns {Set<string>}
 */
const countedReferralFriends = (friends, rewarded, limit) => {
    const counted = new Set();
    const effectiveLimit = effectiveReferralLimit(friends, rewarded, limit);
    for (const name of friends.keys()) if (rewarded.has(name) && counted.size < effectiveLimit) counted.add(name);
    const rest = [...friends.entries()].filter(([name]) => !counted.has(name)).sort((a, b) => _recordTime(a[1]) - _recordTime(b[1]));
    for (const [name] of rest) {
        if (counted.size >= effectiveLimit) break;
        counted.add(name);
    }
    return counted;
};

/** Full referral key (`name.domain`), matching the value stored on a friend's record. */
const canonicalReferralTagName = (name, domain) => {
    const normalized = referralName(name);
    if (!normalized) return "";
    if (normalized.includes(".")) return normalized;
    const tld = String(domain || "")
        .replace(/^\./, "")
        .trim()
        .toLowerCase();
    return tld ? `${normalized}.${tld}` : normalized;
};

/**
 * Spots left for a brand-new referral. Uses `countedReferralFriends`, so a new friend is
 * accepted only when they would land inside the same set a reward claim would pay.
 * @param {Map<string, Object>} friends
 * @param {Set<string>} rewarded
 * @param {number} [limit]
 */
const referralCapacity = (friends, rewarded, limit = referralRewardLimit()) => {
    const friendMap = friends instanceof Map ? friends : new Map();
    const rewardedSet = rewarded instanceof Set ? rewarded : new Set(rewarded || []);
    const effectiveLimit = effectiveReferralLimit(friendMap, rewardedSet, limit);
    const counted = countedReferralFriends(friendMap, rewardedSet, limit);
    const spotsRemaining = Math.max(0, effectiveLimit - counted.size);
    return {
        limit,
        counted,
        countedFriends: counted.size,
        spotsRemaining,
        acceptsNewReferrals: spotsRemaining > 0,
    };
};

module.exports = {
    DEFAULT_REFERRAL_REWARD_LIMIT,
    referralRewardLimit,
    countedReferralFriends,
    canonicalReferralTagName,
    referralCapacity,
    referralName,
    rewardFriendKeys,
    findReferralRecord,
    groupReferralRecords,
    explicitReferralPrice,
};
