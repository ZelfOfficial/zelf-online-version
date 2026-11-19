const config = require("../../../Core/config");
const { sessionlessAppLane } = require("../middlewares/sessionless-rpc.middleware");

const base = "/rpc";

/**
 * Compatibility lane for published native apps (POST /api/rpc/:chainKey only).
 * Registered before JWT. Requests that carry Authorization, and every request
 * while the lane is off, call next() and continue to the protected route.
 */
module.exports = (server) => {
    const PATH = config.basePath(base);

    server.post(`${PATH}/:chainKey`, sessionlessAppLane);
};
