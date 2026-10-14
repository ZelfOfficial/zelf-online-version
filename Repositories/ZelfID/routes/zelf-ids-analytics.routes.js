const config = require("../../../Core/config");
const Controller = require("../controllers/zelf-ids-analytics.controller");
const Middleware = require("../middlewares/zelf-ids-analytics.middleware");

/** Dashboard analytics (license owner / staff of the domain): cached summary + paginated drill-down. */
module.exports = (server) => {
    const PATH = config.basePath("/zelf-ids/analytics");
    server.get(`${PATH}/summary`, Middleware.summaryValidation, Controller.getSummary);
    server.get(`${PATH}/records`, Middleware.recordsValidation, Controller.listRecords);
};
