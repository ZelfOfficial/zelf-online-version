const config = require("../../../Core/config");

const Controller = require("../controllers/rewards.controller");
const Middleware = require("../middlewares/rewards.middleware");
const FaceMiddleware = require("../../Face/middlewares/face.middleware");

const base = "/rewards";

module.exports = (server) => {
	const PATH = config.basePath(base);

	// Roulette wheel configuration
	server.get(`${PATH}/roulette-wheel`, Middleware.rouletteWheelValidation, Controller.getRouletteWheel);

	// Daily rewards. Face gate matches other owner actions; the module checks the rewarded Zelf ID.
	server.post(`${PATH}/daily`, Middleware.dailyRewardsValidation, FaceMiddleware.gate("daily-reward"), Controller.dailyRewards);

	server.post(`${PATH}/first-transaction`, Middleware.firstTransactionRewardValidation, Controller.firstTransactionReward);

	server.get(`${PATH}/history/:tagName`, Middleware.rewardHistoryValidation, Controller.rewardHistory);

	server.get(`${PATH}/stats/:tagName`, Middleware.rewardStatsValidation, Controller.rewardStats);
};






