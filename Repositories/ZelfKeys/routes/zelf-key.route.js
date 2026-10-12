const Controller = require("../controllers/zelf-key.controller.js");
const Middleware = require("../middlewares/zelf-key.middleware.js");
const config = require("../../../Core/config");

/**
 * ZelfKey Routes - Password manager API endpoints
 * @author Miguel Trevino <miguel@zelf.world>
 */
const base = "/zelf-keys";

module.exports = (server) => {
    const PATH = config.basePath(base);

    server.post(`${PATH}/store/password`, Middleware.storePasswordValidation, Controller.storePassword);
    server.post(`${PATH}/store/passwords`, Middleware.storePasswordsBulkValidation, Controller.storePasswordsBulk);
    server.post(`${PATH}/store/zotp`, Middleware.storeZOTPValidation, Controller.storeZOTP);
    server.post(`${PATH}/store/notes`, Middleware.storeNotesValidation, Controller.storeNotes);
    server.post(`${PATH}/store/credit-card`, Middleware.storeCreditCardValidation, Controller.storeCreditCard);

    // add records, that don't require subscription but pay with ZNS!
    server.post(`${PATH}/add/password`, Middleware.storePasswordValidation, Controller.storePassword);
    server.post(`${PATH}/add/zotp`, Middleware.storeZOTPValidation, Controller.storeZOTP);
    server.post(`${PATH}/add/notes`, Middleware.storeNotesValidation, Controller.storeNotes);
    server.post(`${PATH}/add/credit-card`, Middleware.storeCreditCardValidation, Controller.storeCreditCard);

    server.get(`${PATH}/list`, Middleware.listValidation, Controller.listData);
    server.get(`${PATH}/proof`, Middleware.proofValidation, Controller.getProof);
    server.get(`${PATH}/list-all`, Middleware.listAllValidation, Controller.listAllData);
    server.get(`${PATH}/summary`, Middleware.summaryValidation, Controller.summarizeData);
    server.post(`${PATH}/retrieve`, Middleware.retrieveValidation, Controller.retrieveData);
    server.post(`${PATH}/preview`, Middleware.previewValidation, Controller.previewData);
    server.post(`${PATH}/change-master-password`, Middleware.changeMasterPasswordValidation, Controller.changeMasterPassword);

    server.put(`${PATH}/delete/:id`, Middleware.deleteZelfKeyValidation, Controller.deleteZelfKey);

    // admin endpoints
    server.get(`${PATH}/dashboard/list`, Middleware.listDashboardValidation, Controller.listDataDashboard);
    server.get(`${PATH}/dashboard/list-all`, Middleware.listAllDashboardValidation, Controller.listAllDataDashboard);
};
