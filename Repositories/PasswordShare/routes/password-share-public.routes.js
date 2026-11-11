const config = require("../../../Core/config");
const Controller = require("../controllers/password-share.controller");
const Middleware = require("../middlewares/password-share.middleware");

/**
 * Public half of secure password sharing. Mounted from
 * Routes/unprotected-repositories.js, before koa-jwt.
 *
 * CORS is the app-wide `cors()` in server.js, which allows every origin
 * (`Access-Control-Allow-Origin: *`). The landing site at config.landingUrl
 * (production `https://zelf.world`, development `http://localhost:3009`)
 * can call these routes without cookies. The decryption key is the URL
 * fragment and is not part of the request.
 */
module.exports = (server) => {
	const PATH = config.basePath("/password-shares");

	server.get(`${PATH}/:id`, Middleware.rateLimit("metadata"), Middleware.discardRawBody, Controller.metadata);

	server.post(`${PATH}/:id/reveal`, Middleware.rateLimit("reveal"), Middleware.discardRawBody, Controller.reveal);
};
