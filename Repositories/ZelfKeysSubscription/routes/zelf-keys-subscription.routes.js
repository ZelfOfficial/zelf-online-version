const Controller = require("../controllers/zelf-keys-subscription.controller.js");
const Middleware = require("../middlewares/zelf-keys-subscription.middleware.js");

const config = require("../../../Core/config");

const base = "/subscription";

module.exports = (server) => {
	const PATH = config.basePath(base);

	server.get(`${PATH}/plans`, Controller.getAvailablePlans);

	server.post(`${PATH}/check-session`, Middleware.validateCheckSessionRequest, Controller.checkSession);
};
