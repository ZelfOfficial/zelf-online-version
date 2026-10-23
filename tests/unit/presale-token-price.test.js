const config = require("../../Core/config");
const { calculateTokens, getPresaleInfo } = require("../../Repositories/PreSale/modules/presale-pricing.util");

describe("presale token price", () => {
    const originalPrice = config.token.priceUsd;

    afterEach(() => {
        config.token.priceUsd = originalPrice;
    });

    it("keeps the default ZNS price at 0.05 USD", () => {
        expect(config.DEFAULT_TOKEN_PRICE_USD).toBe(0.05);
        expect(config.resolveTokenPriceUsd({})).toBe(0.05);
        expect(config.resolveTokenPriceUsd({ TOKEN_PRICE_USD: "", REWARD_PRICE: "" })).toBe(0.05);
        expect(config.resolveTokenPriceUsd({ TOKEN_PRICE_USD: "0", REWARD_PRICE: "0.2" })).toBe(0.05);
        expect(config.resolveTokenPriceUsd({ TOKEN_PRICE_USD: "nope" })).toBe(0.05);
    });

    it("uses TOKEN_PRICE_USD and falls back to REWARD_PRICE only when that is unset", () => {
        expect(config.resolveTokenPriceUsd({ TOKEN_PRICE_USD: "0.08", REWARD_PRICE: "0.05" })).toBe(0.08);
        expect(config.resolveTokenPriceUsd({ REWARD_PRICE: "0.07" })).toBe(0.07);
        expect(config.resolveTokenPriceUsd({ TOKEN_PRICE_USD: "   ", REWARD_PRICE: "0.09" })).toBe(0.09);
    });

    it("calculates presale tokens at the default price", () => {
        config.token.priceUsd = config.DEFAULT_TOKEN_PRICE_USD;

        expect(config.token.rewardPrice).toBe(0.05);
        expect(config.getTokenPriceUsd()).toBe(0.05);

        const atOneHundred = calculateTokens(100);
        expect(atOneHundred.tokenPriceUsd).toBe(0.05);
        expect(atOneHundred.baseTokens).toBe(2000);
        expect(atOneHundred.bonusPercentage).toBe(10);
        expect(atOneHundred.bonusTokens).toBe(200);
        expect(atOneHundred.totalTokens).toBe(2200);

        const atOneThousand = calculateTokens(1000);
        expect(atOneThousand.baseTokens).toBe(20000);
        expect(atOneThousand.bonusPercentage).toBe(50);
        expect(atOneThousand.totalTokens).toBe(30000);

        const belowBonus = calculateTokens(50);
        expect(belowBonus.bonusPercentage).toBe(0);
        expect(belowBonus.totalTokens).toBe(1000);

        expect(getPresaleInfo()).toEqual({ tokenPriceUsd: 0.05, currency: "USD" });
    });

    it("calculates presale tokens with an overridden price", () => {
        config.token.rewardPrice = 0.1;

        expect(config.token.priceUsd).toBe(0.1);
        expect(config.getTokenPriceUsd()).toBe(0.1);

        const atOneHundred = calculateTokens(100);
        expect(atOneHundred.tokenPriceUsd).toBe(0.1);
        expect(atOneHundred.baseTokens).toBe(1000);
        expect(atOneHundred.bonusPercentage).toBe(10);
        expect(atOneHundred.bonusTokens).toBe(100);
        expect(atOneHundred.totalTokens).toBe(1100);

        const atFiveHundred = calculateTokens(500);
        expect(atFiveHundred.bonusPercentage).toBe(25);
        expect(atFiveHundred.baseTokens).toBe(5000);
        expect(atFiveHundred.totalTokens).toBe(6250);

        expect(getPresaleInfo()).toEqual({ tokenPriceUsd: 0.1, currency: "USD" });
    });

    it("uses the same overridden price for subscription token counts", () => {
        config.token.priceUsd = 0.2;

        const meta = config.buildSubscriptionPricingMeta();

        expect(meta.rewardPrice).toBe(0.2);
        expect(meta.tokenPriceUsd).toBe(0.2);
        expect(meta.encryptTokens).toBe(Math.ceil(meta.encryptUsd / 0.2));
    });

    it("prices tokens with the default when the live value is not positive", () => {
        config.token.priceUsd = 0;

        expect(config.token.rewardPrice).toBe(0);
        expect(config.getTokenPriceUsd()).toBe(0.05);
        expect(calculateTokens(100).baseTokens).toBe(2000);
        expect(getPresaleInfo().tokenPriceUsd).toBe(0.05);
    });
});
