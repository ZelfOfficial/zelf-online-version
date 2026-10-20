const config = require("../../../Core/config");
const Controller = require("../controllers/face-certificates.controller");
const Middleware = require("../middlewares/face-certificates.middleware");
const PaymentMiddleware = require("../middlewares/payment.middleware");
const { optionalJwt } = require("../../HumanAuthn/middlewares/optional-jwt.middleware");
const FaceMiddleware = require("../../Face/middlewares/face.middleware");

const base = "/face-certificates";

module.exports = (server) => {
	const PATH = config.basePath(base);

	server.get(`${PATH}/root-certificate`, Controller.rootCertificate);
	server.get(`${PATH}/payment-stats`, PaymentMiddleware.getPaymentStats);

	server.post(
		`${PATH}/generate`,
		optionalJwt,
		PaymentMiddleware.paymentRequired,
		Middleware.generateValidation,
		FaceMiddleware.gate("encrypt"),
		Controller.generate
	);
	server.post(`${PATH}/verify`, optionalJwt, PaymentMiddleware.paymentRequired, Middleware.verifyValidation, Controller.verify);
	server.post(
		`${PATH}/encrypt`,
		optionalJwt,
		PaymentMiddleware.paymentRequired,
		Middleware.encryptValidation,
		FaceMiddleware.gate("encrypt"),
		Controller.encrypt
	);
	server.post(
		`${PATH}/decrypt`,
		optionalJwt,
		PaymentMiddleware.paymentRequired,
		Middleware.decryptValidation,
		FaceMiddleware.gate("decrypt"),
		Controller.decrypt
	);
	server.post(`${PATH}/sign`, optionalJwt, PaymentMiddleware.paymentRequired, Middleware.signValidation, Controller.sign);
	server.post(
		`${PATH}/public-key`,
		optionalJwt,
		PaymentMiddleware.paymentRequired,
		Middleware.publicKeyValidation,
		Controller.publicKey
	);
	server.post(
		`${PATH}/verify-signature`,
		optionalJwt,
		PaymentMiddleware.paymentRequired,
		Middleware.verifySignatureValidation,
		Controller.verifySignature
	);
	server.post(
		`${PATH}/verify-signature-with-public-key`,
		optionalJwt,
		PaymentMiddleware.paymentRequired,
		Middleware.verifySignatureWithPublicKeyValidation,
		Controller.verifySignatureWithPublicKey
	);
};
