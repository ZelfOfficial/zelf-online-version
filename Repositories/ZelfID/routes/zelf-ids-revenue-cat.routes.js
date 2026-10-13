const config = require("../../../Core/config");
const Controller = require("../controllers/zelf-id.controller");
const Middleware = require("../middlewares/zelf-id.middleware");

/**
 * RevenueCat webhook. Unprotected router: RevenueCat cannot send a JWT; the
 * middleware checks the static Authorization header against REVENUECAT_WEBHOOK_AUTHORIZATION.
 */
module.exports = (server) => {
    const PATH = config.basePath("/zelf-ids");

    server.post(`${PATH}/revenue-cat`, Middleware.revenueCatWebhookValidation, Controller.revenueCatWebhook);
};
