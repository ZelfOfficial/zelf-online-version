const config = require("../../../Core/config");

const Controller = require("../controllers/human-authn.controller");

const Middleware = require("../middlewares/human-authn.middleware");
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
        Controller.encrypt
    );

    server.post(
        `${PATH}/encrypt-qr-code`,
        OptionalJwtMiddleware.optionalJwt,
        PaymentMiddleware.paymentRequired,
        Middleware.encryptValidation,
        Controller.encryptQRCode
    );

    // Retired on v3. Respond before optional JWT, payment, and body validation.
    server.post(`${PATH}/decrypt`, Controller.decrypt);

    server.post(
        `${PATH}/preview`,
        OptionalJwtMiddleware.optionalJwt,
        PaymentMiddleware.paymentRequired,
        Middleware.previewValidation,
        Controller.preview
    );

    // Payment statistics endpoint (no payment required)
    server.get(`${PATH}/payment-stats`, PaymentMiddleware.getPaymentStats);
};
