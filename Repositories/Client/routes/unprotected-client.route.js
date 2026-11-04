const config = require("../../../Core/config");

const Controller = require("../controllers/unprotected-client.controller");
const Middleware = require("../middlewares/client.middleware");
const FaceMiddleware = require("../../Face/middlewares/face.middleware");

const base = "/clients";

module.exports = (server) => {
	const PATH = config.basePath(base);

	// Routes
	server.get(`${PATH}`, Controller.verifyClient);
	server.post(`${PATH}`, Middleware.createValidation, FaceMiddleware.gate("client-face"), Controller.create);
	server.post(`${PATH}/auth`, Middleware.authValidation, FaceMiddleware.gate("client-face"), Controller.auth);
};





