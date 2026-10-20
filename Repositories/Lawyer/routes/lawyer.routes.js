const config = require("../../../Core/config");
const Controller = require("../controllers/lawyer.controller");
const Middleware = require("../middlewares/lawyer.middleware");
const FaceMiddleware = require("../../Face/middlewares/face.middleware");

const base = "/lawyers";

module.exports = (server) => {
	const PATH = config.basePath(base);

	// List lawyers for domain
	server.get(`${PATH}`, Controller.get);

	// Get lawyers + pending invitations combined
	server.get(`${PATH}/all`, Controller.getAll);

	// Get pending invitations only
	server.get(`${PATH}/invitations`, Controller.getInvitations);

	// Current lawyer profile
	server.get(`${PATH}/me`, Controller.getMyProfile);

	// Invite a lawyer
	server.post(`${PATH}/invite`, Middleware.inviteValidation, FaceMiddleware.gate("lawyer-face"), Controller.generateInvitation);

	// Update lawyer profile
	server.put(`${PATH}/profile`, Middleware.updateProfileValidation, FaceMiddleware.gate("lawyer-face"), Controller.updateProfile);

	// Preferred lawyers
	server.get(`${PATH}/preferred`, Controller.getPreferred);
	server.put(`${PATH}/preferred`, Middleware.setPreferredValidation, Controller.setPreferred);

	// Remove lawyer
	server.del(`${PATH}`, Middleware.removeValidation, FaceMiddleware.gate("lawyer-face"), Controller.remove);

	// ERC8004 endpoints
	server.post(`${PATH}/register-identity`, Controller.registerIdentity);
	server.post(`${PATH}/submit-review`, Middleware.submitReviewValidation, Controller.submitReview);
	server.get(`${PATH}/reputation`, Controller.getReputation);
};
