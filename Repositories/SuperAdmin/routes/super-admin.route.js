const config = require("../../../Core/config");

const Controller = require("../controllers/super-admin.controller");
const Middleware = require("../middlewares/super-admin.middleware");
const { verifyBlogSuperAdmin } = require("../middlewares/verify-super-admin.middleware");
const primaryKey = "id";
const base = "/super-admins";

module.exports = (server) => {
	const PATH = config.basePath(base);

	server.get(PATH, Middleware.getValidation, Controller.get);

	server.get(`${PATH}/verify`, verifyBlogSuperAdmin, Controller.verify);

	server.get(`${PATH}/:${primaryKey}`, Middleware.showValidation, Controller.show);

	server.post(`${PATH}`, Middleware.createValidation, Controller.create);

	server.post(`${PATH}/auth`, Middleware.authValidation, Controller.auth);
	
	server.post(`${PATH}/request-otp`, Middleware.requestOtpValidation, Controller.requestOtp);
	
	server.post(`${PATH}/verify-otp`, Middleware.verifyOtpValidation, Controller.verifyOtp);

	server.del(`${PATH}/:${primaryKey}`, Middleware.destroyValidation, Controller.destroy);
};
