const config = require("../../../Core/config");

/**
 * ZNS presale pricing.
 * The USD price of one token is config.getTokenPriceUsd(): TOKEN_PRICE_USD,
 * otherwise the legacy REWARD_PRICE alias, otherwise 0.05. Rewards and
 * subscription grants read that same value.
 */
const BONUS_TIERS = [
    { minAmount: 1000, bonus: 0.5, label: "50% BONUS" },
    { minAmount: 500, bonus: 0.25, label: "25% BONUS" },
    { minAmount: 100, bonus: 0.1, label: "10% BONUS" },
    { minAmount: 0, bonus: 0, label: "NO BONUS" },
];

const getBonusTier = (amount) => {
    return BONUS_TIERS.find((tier) => amount >= tier.minAmount) || BONUS_TIERS[BONUS_TIERS.length - 1];
};

const calculateTokens = (usdAmount) => {
    const tier = getBonusTier(usdAmount);
    const tokenPriceUsd = config.getTokenPriceUsd();
    const baseTokens = usdAmount / tokenPriceUsd;
    const bonusTokens = baseTokens * tier.bonus;

    return {
        baseTokens,
        bonusTokens,
        totalTokens: baseTokens + bonusTokens,
        bonusPercentage: tier.bonus * 100,
        tokenPriceUsd,
    };
};

/**
 * Public presale snapshot for GET /api/presale/info.
 * @returns {{ tokenPriceUsd: number, currency: string }}
 */
const getPresaleInfo = () => ({
    tokenPriceUsd: config.getTokenPriceUsd(),
    currency: "USD",
});

module.exports = {
    BONUS_TIERS,
    calculateTokens,
    getBonusTier,
    getPresaleInfo,
};
