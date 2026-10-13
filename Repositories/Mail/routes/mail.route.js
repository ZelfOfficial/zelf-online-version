const config = require("../../../Core/config");

const Controller = require("../controllers/mail.controller");
const InboundController = require("../controllers/inbound.controller");

const Middleware = require("../middlewares/mail.middleware");
const { mailgunSignatureValidator } = require("../middlewares/mailgun-signature.middleware");
const { superAdminKeyValidator } = require("../middlewares/super-admin-key.middleware");
const InboundMiddleware = require("../middlewares/inbound.middleware");

const base = "/mail";

module.exports = (server) => {
    const PATH = config.basePath(base);

    // Legacy stub, now signature-protected.
    server.post(`${PATH}/webhook`, Middleware.webhookValidator, Controller.webhookHandler);

    // Mailgun route target for jim@mg.zelf.world (public, Mailgun-signed).
    server.post(`${PATH}/inbound/jim`, mailgunSignatureValidator, InboundController.receive);

    // Jim's mailbox API (super-admin key / JWT).
    server.get(`${PATH}/inbound`, superAdminKeyValidator, InboundController.list);
    server.get(`${PATH}/inbound/:id`, superAdminKeyValidator, InboundController.get);
    server.patch(`${PATH}/inbound/:id`, superAdminKeyValidator, InboundMiddleware.updateValidation, InboundController.update);
};
