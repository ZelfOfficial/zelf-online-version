const config = require("../../../Core/config");
const Controller = require("../controllers/zelf-id.controller");
const Middleware = require("../middlewares/zelf-id.middleware");

/**
 * Public referral check. Unprotected router: apps call this before signup, with no session.
 * GET /api/zelf-ids/referral-availability?tagName=alice&domain=zelf
 */
module.exports = (server) => {
    const PATH = config.basePath("/zelf-ids");

    server.get(`${PATH}/referral-availability`, Middleware.referralAvailabilityValidation, Controller.referralAvailability);
};
