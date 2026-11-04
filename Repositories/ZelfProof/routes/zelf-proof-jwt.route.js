const config = require("../../../Core/config");

const Controller = require("../controllers/zelf-proof.controller");
const Middleware = require("../middlewares/zelf-proof.middleware");
const FaceMiddleware = require("../../Face/middlewares/face.middleware");

const base = "/jwt/zelf-proof";

/**
 * Development-only mirror of `/api/zelf-proof`. Trades the ZNS payment gate for
 * the JWT that the protected registry already enforces, so local tests can run
 * without on-chain payments. Usage metering for unpaid calls is still undecided,
 * so this must not reach production.
 */
module.exports = (server) => {
    if (config.env !== "development") return;

    const PATH = config.basePath(base);

    server.post(`${PATH}/encrypt`, Middleware.encryptValidation, FaceMiddleware.gate("encrypt"), Controller.encrypt);
    server.post(`${PATH}/encrypt-qr-code`, Middleware.encryptValidation, FaceMiddleware.gate("encrypt"), Controller.encryptQRCode);
    server.post(`${PATH}/decrypt`, Middleware.decryptValidation, FaceMiddleware.gate("decrypt"), Controller.decrypt);
    server.post(`${PATH}/preview`, Middleware.previewValidation, Controller.preview);

    console.info(`[dev] JWT routes mounted at ${PATH} (no ZNS payment)`);
};
