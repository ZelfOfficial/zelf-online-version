const config = require("../../../Core/config");

const Controller = require("../controllers/article.controller");

const Middleware = require("../middlewares/article.middleware");
const { verifySuperAdmin } = require("../../SuperAdmin/middlewares/verify-super-admin.middleware");

const base = "/articles";

module.exports = (server) => {
    const PATH = config.basePath(base);

    server.post(`${PATH}`, verifySuperAdmin, Middleware.createValidation, Controller.create);

    server.get(`${PATH}`, Controller.getAll);

    server.get(`${PATH}/:slug`, Controller.getBySlug);

    server.post(`${PATH}/:slug/send-test`, verifySuperAdmin, Middleware.sendTestValidation, Controller.sendTest);

    server.post(`${PATH}/:slug/send-all`, verifySuperAdmin, Controller.sendToAll);

    // Open tracking pixel (unprotected)
    server.get(`${PATH}/track/:articleId/:subscriberEmail`, Controller.trackOpen);
};
