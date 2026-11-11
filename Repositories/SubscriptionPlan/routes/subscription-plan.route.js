const config = require("../../../Core/config");
const { respondStripeMoved } = require("../../Stripe/stripe-moved");

const base = "/subscription-plans";

module.exports = (server) => {
	const PATH = config.basePath(base);

	server.get(`${PATH}`, respondStripeMoved);
	server.get(`${PATH}/my-subscription`, respondStripeMoved);
	server.get(`${PATH}/:productId`, respondStripeMoved);
	server.post(`${PATH}/subscribe`, respondStripeMoved);
	server.post(`${PATH}/create-portal-session`, respondStripeMoved);
	server.post(`${PATH}/verify-session`, respondStripeMoved);
	server.post(`${PATH}/reconcile-zns`, respondStripeMoved);
};
