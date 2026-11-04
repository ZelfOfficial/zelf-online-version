const config = require("../../../Core/config");

const Controller = require("../controllers/mail.controller");
const InboundController = require("../controllers/inbound.controller");

const Middleware = require("../middlewares/mail.middleware");
const { mailgunSignatureValidator } = require("../middlewares/mailgun-signature.middleware");
const { jimInboxKeyValidator } = require("../middlewares/jim-inbox-key.middleware");
const InboundMiddleware = require("../middlewares/inbound.middleware");

const base = "/mail";

module.exports = (server) => {
    const PATH = config.basePath(base);

    // Legacy stub, now signature-protected.
    server.post(`${PATH}/webhook`, Middleware.webhookValidator, Controller.webhookHandler);

    // Mailgun route target for jim@mg.zelf.world (public, Mailgun-signed).
    server.post(`${PATH}/inbound/jim`, mailgunSignatureValidator, InboundController.receive);

    // Jim's mailbox API (dedicated JIM_INBOX_API_KEY).
    server.get(`${PATH}/inbound`, jimInboxKeyValidator, InboundController.list);
    server.get(`${PATH}/inbound/:id`, jimInboxKeyValidator, InboundController.get);
    server.patch(`${PATH}/inbound/:id`, jimInboxKeyValidator, InboundMiddleware.updateValidation, InboundController.update);
};
