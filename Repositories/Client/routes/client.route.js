const config = require("../../../Core/config");

const Controller = require("../controllers/client.controller");
const Middleware = require("../middlewares/client.middleware");
const FaceMiddleware = require("../../Face/middlewares/face.middleware");
const base = "/clients";

module.exports = (server) => {
	const PATH = config.basePath(base);

	// Routes
	server.put(`${PATH}/sync`, Middleware.updateValidation, FaceMiddleware.gate("client-face"), Controller.update);
	server.put(`${PATH}/sync/password`, Middleware.updatePasswordValidation, FaceMiddleware.gate("client-face"), Controller.updatePassword);
	server.del(`${PATH}`, Middleware.destroyValidation, Controller.destroy);
};
