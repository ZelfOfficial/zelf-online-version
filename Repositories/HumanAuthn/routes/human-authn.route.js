const config = require("../../../Core/config");

const Controller = require("../controllers/human-authn.controller");

const Middleware = require("../middlewares/human-authn.middleware");
const FaceMiddleware = require("../../Face/middlewares/face.middleware");
const PaymentMiddleware = require("../middlewares/payment.middleware");
const OptionalJwtMiddleware = require("../middlewares/optional-jwt.middleware");

const base = "/human-authn";

module.exports = (server) => {
    const PATH = config.basePath(base);

    // Routes with payment middleware (HTTP 402)
    server.post(
        `${PATH}/encrypt`,
        OptionalJwtMiddleware.optionalJwt,
        PaymentMiddleware.paymentRequired,
        Middleware.encryptValidation,
        FaceMiddleware.gate("encrypt"),
        Controller.encrypt
    );

    server.post(
        `${PATH}/encrypt-qr-code`,
        OptionalJwtMiddleware.optionalJwt,
        PaymentMiddleware.paymentRequired,
        Middleware.encryptValidation,
        FaceMiddleware.gate("encrypt"),
        Controller.encryptQRCode
    );

    server.post(
        `${PATH}/decrypt`,
        OptionalJwtMiddleware.optionalJwt,
        PaymentMiddleware.paymentRequired,
        Middleware.decryptValidation,
        FaceMiddleware.gate("decrypt"),
        Controller.decrypt
    );

    server.post(
        `${PATH}/preview`,
        OptionalJwtMiddleware.optionalJwt,
        PaymentMiddleware.paymentRequired,
        Middleware.previewValidation,
        Controller.preview
    );

    server.post(
        `${PATH}/upgrade`,
        OptionalJwtMiddleware.optionalJwt,
        PaymentMiddleware.paymentRequired,
        Middleware.upgradeValidation,
        FaceMiddleware.gate("upgrade"),
        Controller.upgrade
    );

    // Payment statistics endpoint (no payment required)
    server.get(`${PATH}/payment-stats`, PaymentMiddleware.getPaymentStats);
};
