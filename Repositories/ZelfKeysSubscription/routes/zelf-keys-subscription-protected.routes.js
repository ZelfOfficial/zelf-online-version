const Controller = require("../controllers/zelf-keys-subscription.controller.js");
const Middleware = require("../middlewares/zelf-keys-subscription.middleware.js");
const { respondStripeMoved } = require("../../Stripe/stripe-moved");
const config = require("../../../Core/config");

const base = "/subscription";

module.exports = (server) => {
	const PATH = config.basePath(base);

	server.get(`${PATH}/active`, Middleware.validateUserIdentifier, Controller.getActiveSubscription);
	server.post(`${PATH}/checkout`, respondStripeMoved);
	server.post(`${PATH}/cancel`, respondStripeMoved);
	server.post(`${PATH}/portal`, respondStripeMoved);
	server.post(`${PATH}/crypto-payment`, Middleware.validateUserIdentifier, Controller.createCryptoPayment);
	server.post(`${PATH}/confirm-crypto-payment`, Middleware.validateUserIdentifier, Controller.confirmCryptoPayment);
};
