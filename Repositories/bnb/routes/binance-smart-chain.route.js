const config = require("../../../Core/config");

const Controller = require("../controllers/binance-smart-chain.controller");
const Middleware = require("../middlewares/binance-smart-chain.middleware");

const baseBsc = "/bsc";
const baseBnb = "/bnb";

module.exports = (server) => {
	const PATH_BSC = config.basePath(baseBsc);
	const PATH_BNB = config.basePath(baseBnb);

	// BSC endpoints
	server.get(`${PATH_BSC}/address/:id`, Middleware.validateAddressParam, Controller.address);
	server.get(`${PATH_BSC}/address/:id/transactions`, Middleware.validateAddressTransactions, Controller.transactionsList);
	server.get(`${PATH_BSC}/gas-tracker`, Middleware.validateToken, Controller.gasTracker);
	server.get(`${PATH_BSC}/transaction/:id`, Middleware.validateToken, Controller.transactionStatus);

	// BNB endpoints (duplicated for backward compatibility)
	server.get(`${PATH_BNB}/address/:id`, Middleware.validateAddressParam, Controller.address);
	server.get(`${PATH_BNB}/address/:id/transactions`, Middleware.validateAddressTransactions, Controller.transactionsList);
	server.get(`${PATH_BNB}/gas-tracker`, Middleware.validateToken, Controller.gasTracker);
	server.get(`${PATH_BNB}/transaction/:id`, Middleware.validateToken, Controller.transactionStatus);
};
