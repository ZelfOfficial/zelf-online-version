const config = require("../../../Core/config");
const Controller = require("../controllers/unprotected-lawyer.controller");
const Middleware = require("../middlewares/lawyer.middleware");
const FaceMiddleware = require("../../Face/middlewares/face.middleware");

const base = "/lawyers";

module.exports = (server) => {
	const PATH = config.basePath(base);

	// Public search
	server.get(`${PATH}/search`, Middleware.searchValidation, Controller.search);

	// Get lawyer by zelfName
	server.get(`${PATH}/by-zelf-name/:zelfName`, Controller.getByZelfName);

	// Public reputation query
	server.get(`${PATH}/reputation`, Controller.getReputation);

	// Invitation flow (no auth)
	server.get(`${PATH}/validate-invite`, Controller.validateInvitation);
	server.post(`${PATH}/accept-invite`, Middleware.createFromInvitationValidation, FaceMiddleware.gate("lawyer-face"), Controller.createFromInvitation);

	// Lawyer auth
	server.post(`${PATH}/auth`, Middleware.authValidation, FaceMiddleware.gate("lawyer-face"), Controller.auth);
};
