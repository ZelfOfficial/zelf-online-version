const Module = require("../modules/rewards.module");
const { errorHandler } = require("../../../Core/http-handler");

const dailyRewards = async (ctx) => {
    try {
        const data = await Module.dailyRewards(ctx.request.body, ctx.state.user);

        ctx.body = data;
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;

        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

const rewardHistory = async (ctx) => {
    try {
        const { tagName } = ctx.request.params;
        const { limit, domain } = ctx.request.query;

        const data = await Module.getUserRewardHistory(tagName, domain, limit);

        ctx.body = data;
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;

        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

const rewardStats = async (ctx) => {
    try {
        const { tagName } = ctx.request.params;
        const { domain } = ctx.request.query;

        const data = await Module.getUserRewardStats(tagName, domain);

        ctx.body = data;
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;

        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

const firstTransactionReward = async (ctx) => {
    try {
        const data = await Module.rewardFirstTransaction(ctx.request.body, ctx.state.user);

        ctx.body = data;
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = error.status || 500;

        ctx.body = { error: error.message };
    }
};

const getRouletteWheel = async (ctx) => {
    try {
        const { tagName, domain } = ctx.request.query;

        const data = await Module.getRouletteWheel({ tagName, domain }, ctx.state.user);

        ctx.body = data;
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;

        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

module.exports = {
    dailyRewards,
    rewardHistory,
    rewardStats,
    firstTransactionReward,
    getRouletteWheel,
};
