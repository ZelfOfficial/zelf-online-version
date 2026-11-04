const config = require("../../../Core/config");
const Controller = require("../controllers/zelf-ids-coupons.controller");
const Middleware = require("../middlewares/zelf-ids-coupons.middleware");

/** Super-admin: create, list, and deactivate Zelf ID plan coupons. */
module.exports = (server) => {
    const PATH = config.basePath("/zelf-ids/coupons");

    server.post(PATH, Middleware.requireSuperAdmin, Middleware.createValidation, Controller.create);
    server.get(PATH, Middleware.requireSuperAdmin, Controller.list);
    server.post(`${PATH}/:id/deactivate`, Middleware.requireSuperAdmin, Controller.deactivate);
};
