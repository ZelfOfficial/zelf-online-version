const config = require("../../../Core/config");
const Controller = require("../controllers/rpc.controller");
const Middleware = require("../middlewares/rpc.middleware");
const { requireAllowedProtectedRpcOrigin } = require("../middlewares/protected-rpc-origin.middleware");

const base = "/rpc";

module.exports = (server) => {
    const PATH = config.basePath(base);

    // Mounted with the protected routers, so koa-jwt runs first.
    // Same JSON-RPC body as POST /api/protected/rpc/:chainKey.
    // Previously this path was unauthenticated. Callers must send a session JWT.
    // zelf-dashboard does not call it. The extension uses /api/protected/rpc.
    server.get(`${PATH}/chains`, requireAllowedProtectedRpcOrigin, Controller.getChains);
    server.post(
        `${PATH}/request`,
        requireAllowedProtectedRpcOrigin,
        Middleware.assertRpcBodyLimit(false),
        Middleware.requestValidation,
        Controller.request
    );
    server.post(
        `${PATH}/:chainKey`,
        requireAllowedProtectedRpcOrigin,
        Middleware.assertRpcBodyLimit(true),
        Middleware.jsonRpcValidation,
        Controller.requestJsonRpc
    );
};
