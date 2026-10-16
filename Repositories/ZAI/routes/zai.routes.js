const config = require("../../../Core/config");

const Controller = require("../controllers/zai.controller");

const Middleware = require("../middlewares/zai.middleware");

const base = "/zai";

// Registered on the unprotected router (Routes/unprotected-repositories.js): identity/zAI tokens are
// signed with their own secrets and checked by Middleware, not by the session JWT guard.
module.exports = (server) => {
    const PATH = config.basePath(base);

    server.post(`${PATH}/session`, Middleware.identityTokenValidation, Controller.createSession);

    server.post(`${PATH}/revoke`, Middleware.identityTokenValidation, Controller.revokeIdentity);

    server.post(`${PATH}/chat`, Middleware.zaiTokenValidation, Middleware.chatValidation, Controller.chat);

    server.get(`${PATH}/me`, Middleware.zaiTokenValidation, Controller.getMe);
};
