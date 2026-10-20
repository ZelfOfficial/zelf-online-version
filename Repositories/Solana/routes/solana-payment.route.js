const config = require("../../../Core/config");
const Controller = require("../controllers/solana-payment.controller");
const Middleware = require("../middlewares/solana-payment.middleware");
const SessionMiddleware = require("../../Session/middlewares/session.middleware");
const FaceMiddleware = require("../../Face/middlewares/face.middleware");

const base = "/solana";

module.exports = (server) => {
	const PATH = config.basePath(base);

	// Payment route - requires JWT authentication
	server.post(`${PATH}/payment`, SessionMiddleware.validateJWT, Middleware.createAndSubmitPaymentValidation, FaceMiddleware.gate("solana-payment"), Controller.createAndSubmitPayment);

	// Service wallet info - public endpoint
	server.get(`${PATH}/payment/service-wallet`, Controller.getServiceWallet);
};
