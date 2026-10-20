const config = require("../../../Core/config");
const Controller = require("../controllers/staff.controller");
const Middleware = require("../middlewares/staff.middleware");
const FaceMiddleware = require("../../Face/middlewares/face.middleware");

const base = "/staff";

module.exports = (server) => {
	const PATH = config.basePath(base);

	server.get(`${PATH}`, Controller.get);

	server.post(`${PATH}/invite`, Middleware.inviteValidation, FaceMiddleware.gate("staff-face"), Controller.generateInvitation);

	server.put(`${PATH}/role`, Middleware.updateRoleValidation, FaceMiddleware.gate("staff-face"), Controller.updateRole);

	server.del(`${PATH}`, Middleware.removeValidation, FaceMiddleware.gate("staff-face"), Controller.remove);

	server.post(`${PATH}/passkeys`, Middleware.savePasskeyValidation, Controller.savePasskey);

	server.get(`${PATH}/passkeys/ipfs-details`, Controller.getPasskeyIpfsDetails);

	server.del(`${PATH}/passkeys`, Controller.deletePasskey);

	server.put(`${PATH}`, Middleware.updateProfileValidation, FaceMiddleware.gate("staff-face"), Controller.updateProfile);
};
