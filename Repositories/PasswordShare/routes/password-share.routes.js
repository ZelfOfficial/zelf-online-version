const config = require("../../../Core/config");
const Controller = require("../controllers/password-share.controller");
const Middleware = require("../middlewares/password-share.middleware");

/**
 * Owner half of secure password sharing. Mounted from
 * Routes/protected-repositories.js, after koa-jwt.
 * A normal session from POST /api/sessions is enough. Ownership is that
 * session's `identifier`.
 */
module.exports = (server) => {
	const PATH = config.basePath("/password-shares");

	server.post(PATH, Middleware.exposeRetryAfter, Middleware.rateLimit("create"), Middleware.discardRawBody, Controller.create);

	server.get(PATH, Middleware.exposeRetryAfter, Middleware.discardRawBody, Controller.list);

	server.delete(`${PATH}/:id`, Middleware.exposeRetryAfter, Middleware.discardRawBody, Controller.revoke);
};
