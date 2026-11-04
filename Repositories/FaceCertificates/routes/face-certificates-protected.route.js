const config = require("../../../Core/config");
const Controller = require("../controllers/face-certificates.controller");
const Middleware = require("../middlewares/face-certificates.middleware");
const FaceMiddleware = require("../../Face/middlewares/face.middleware");

const base = "/my-face-certificates";

module.exports = (server) => {
	const PATH = config.basePath(base);

	server.post(`${PATH}/generate`, Middleware.generateValidation, FaceMiddleware.gate("encrypt"), Controller.generate);
	server.post(`${PATH}/verify`, Middleware.verifyValidation, Controller.verify);
	server.post(`${PATH}/encrypt`, Middleware.encryptValidation, FaceMiddleware.gate("encrypt"), Controller.encrypt);
	server.post(`${PATH}/decrypt`, Middleware.decryptValidation, FaceMiddleware.gate("decrypt"), Controller.decrypt);
	server.post(`${PATH}/sign`, Middleware.signValidation, Controller.sign);
	server.post(`${PATH}/public-key`, Middleware.publicKeyValidation, Controller.publicKey);
	server.post(`${PATH}/verify-signature`, Middleware.verifySignatureValidation, Controller.verifySignature);
	server.post(
		`${PATH}/verify-signature-with-public-key`,
		Middleware.verifySignatureWithPublicKeyValidation,
		Controller.verifySignatureWithPublicKey
	);
};
