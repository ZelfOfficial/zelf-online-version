const config = require("../../../Core/config");

const Controller = require("../controllers/zelf-proof.controller");

const Middleware = require("../middlewares/zelf-proof.middleware");
const FaceMiddleware = require("../../Face/middlewares/face.middleware");
const PaymentMiddleware = require("../middlewares/payment.middleware");

const base = "/zelf-proof";

module.exports = (server) => {
    const PATH = config.basePath(base);

    // Routes with payment middleware (HTTP 402)
    server.post(`${PATH}/encrypt`, PaymentMiddleware.paymentRequired, Middleware.encryptValidation, FaceMiddleware.gate("encrypt"), Controller.encrypt);

    server.post(`${PATH}/encrypt-qr-code`, PaymentMiddleware.paymentRequired, Middleware.encryptValidation, FaceMiddleware.gate("encrypt"), Controller.encryptQRCode);

    server.post(`${PATH}/decrypt`, PaymentMiddleware.paymentRequired, Middleware.decryptValidation, FaceMiddleware.gate("decrypt"), Controller.decrypt);

    server.post(`${PATH}/preview`, PaymentMiddleware.paymentRequired, Middleware.previewValidation, Controller.preview);

    // Payment statistics endpoint (no payment required)
    server.get(`${PATH}/payment-stats`, PaymentMiddleware.getPaymentStats);
};





