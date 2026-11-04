const config = require("../../../Core/config.js");

const Controller = require("../controllers/lifi.controller.js");
const Middleware = require("../middlewares/lifi.middleware.js");
const SessionMiddleware = require("../../Session/middlewares/session.middleware");

const base = "/lifi";

module.exports = (server) => {
	const PATH = config.basePath(base);

	server.get(`${PATH}/chains`, SessionMiddleware.validateJWT, Middleware.getChainsValidation, Controller.getChains);
	server.get(`${PATH}/quote`, SessionMiddleware.validateJWT, Middleware.getQuoteValidation, Controller.getQuote);
	server.get(`${PATH}/status`, SessionMiddleware.validateJWT, Middleware.getStatusValidation, Controller.getStatus);
	server.get(`${PATH}/token`, SessionMiddleware.validateJWT, Middleware.getTokenByChainIdValidation, Controller.getTokenByChainId);
	server.get(`${PATH}/tokens`, SessionMiddleware.validateJWT, Middleware.getTokensValidation, Controller.getTokens);
	server.get(`${PATH}/tools`, SessionMiddleware.validateJWT, Middleware.getToolsValidation, Controller.getTools);

	// Counts as one swap after LI.FI returns the transaction. GET /quote is a price lookup and is not counted.
	// POST the quote response `data` object unchanged. It is the LI.FI step.
	server.post(
		`${PATH}/execute-advanced-step-transaction`,
		SessionMiddleware.validateJWT,
		Middleware.executeAdvancedStepTransactionValidation,
		Controller.executeAdvancedStepTransaction
	);
};
