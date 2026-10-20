const config = require("../../../Core/config");
const Controller = require("../controllers/unprotected-staff.controller");
const Middleware = require("../middlewares/staff.middleware");
const FaceMiddleware = require("../../Face/middlewares/face.middleware");

const base = "/staff";

module.exports = (server) => {
	const PATH = config.basePath(base);

	// Routes
	server.get(`${PATH}/validate-invite`, Controller.validateInvitation);
	server.post(`${PATH}/accept-invite`, Middleware.createFromInvitationValidation, FaceMiddleware.gate("staff-face"), Controller.createFromInvitation);
	server.post(`${PATH}/auth`, Middleware.authValidation, FaceMiddleware.gate("staff-face"), Controller.auth);
	server.get(`${PATH}/passkeys`, Controller.getPasskey);
};
