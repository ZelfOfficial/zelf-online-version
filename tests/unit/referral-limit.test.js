const {
    countedReferralFriends,
    referralRewardLimit,
    DEFAULT_REFERRAL_REWARD_LIMIT,
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
});
