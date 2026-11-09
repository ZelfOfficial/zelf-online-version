const {
    countedReferralFriends,
    referralCapacity,
    referralRewardLimit,
    DEFAULT_REFERRAL_REWARD_LIMIT,
    canonicalReferralTagName,
} = require("../../Repositories/Tags/modules/referral-reward.util");

const friends = (n) =>
    new Map(
        Array.from({ length: n }, (_, i) => [`f${i}.zelf`, { publicData: { registeredAt: `2026-01-${String(i + 1).padStart(2, "0")} 00:00:00` } }])
    );

describe("referral reward limit (#45)", () => {
    test("default limit is 10, env override", () => {
        expect(DEFAULT_REFERRAL_REWARD_LIMIT).toBe(10);
        expect(referralRewardLimit(undefined)).toBe(10);
        expect(referralRewardLimit("5")).toBe(5);
        expect(referralRewardLimit("x")).toBe(10);
    });

    test("11 friends: first 10 count, the 11th is history", () => {
        const counted = countedReferralFriends(friends(11), new Set(), 10);
        expect(counted.size).toBe(10);
        expect(counted.has("f10.zelf")).toBe(false);
        expect(counted.has("f0.zelf")).toBe(true);
    });

    test("already rewarded friends always count first", () => {
        const counted = countedReferralFriends(friends(12), new Set(["f11.zelf"]), 10);
        expect(counted.has("f11.zelf")).toBe(true);
        expect(counted.size).toBe(10);
        expect(counted.has("f9.zelf")).toBe(false);
    });

    test("spots remaining uses the same counted set as a reward claim", () => {
        const under = referralCapacity(friends(3), new Set(), 10);
        expect(under.counted).toEqual(countedReferralFriends(friends(3), new Set(), 10));
        expect(under).toMatchObject({ limit: 10, countedFriends: 3, spotsRemaining: 7, acceptsNewReferrals: true });

        const full = referralCapacity(friends(10), new Set(), 10);
        expect(full.spotsRemaining).toBe(0);
        expect(full.acceptsNewReferrals).toBe(false);
        expect(full.counted.has("f9.zelf")).toBe(true);

        const withExternal = referralCapacity(friends(8), new Set(["outside.zelf", "other.zelf"]), 10);
        expect(withExternal.countedFriends).toBe(8);
        expect(withExternal.spotsRemaining).toBe(0);
        expect(withExternal.acceptsNewReferrals).toBe(false);
    });

    test("canonical referral key matches the stored name.domain", () => {
        expect(canonicalReferralTagName("Alice", "zelf")).toBe("alice.zelf");
        expect(canonicalReferralTagName("alice.zelf.hold", "zelf")).toBe("alice.zelf");
        expect(canonicalReferralTagName("alice.zelf", "zelf")).toBe("alice.zelf");
    });
});
