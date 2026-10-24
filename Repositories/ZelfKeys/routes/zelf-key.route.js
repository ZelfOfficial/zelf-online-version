const Controller = require("../controllers/zelf-key.controller.js");
const Middleware = require("../middlewares/zelf-key.middleware.js");
const config = require("../../../Core/config");
const FaceMiddleware = require("../../Face/middlewares/face.middleware");

/**
 * ZelfKey Routes - Password manager API endpoints
 * @author Miguel Trevino <miguel@zelf.world>
 */
const base = "/zelf-keys";

module.exports = (server) => {
    const PATH = config.basePath(base);

    server.post(`${PATH}/store/password`, Middleware.storePasswordValidation, FaceMiddleware.gate("store-password"), Controller.storePassword);
    server.post(`${PATH}/store/passwords`, Middleware.storePasswordsBulkValidation, FaceMiddleware.gate("store-passwords-bulk"), Controller.storePasswordsBulk);
    server.post(`${PATH}/store/zotp`, Middleware.storeZOTPValidation, FaceMiddleware.gate("store-zotp"), Controller.storeZOTP);
    server.post(`${PATH}/store/notes`, Middleware.storeNotesValidation, FaceMiddleware.gate("store-notes"), Controller.storeNotes);
    server.post(`${PATH}/store/credit-card`, Middleware.storeCreditCardValidation, FaceMiddleware.gate("store-credit-card"), Controller.storeCreditCard);

    // add records, that don't require subscription but pay with ZNS!
    server.post(`${PATH}/add/password`, Middleware.storePasswordValidation, FaceMiddleware.gate("store-password"), Controller.storePassword);
    server.post(`${PATH}/add/zotp`, Middleware.storeZOTPValidation, FaceMiddleware.gate("store-zotp"), Controller.storeZOTP);
    server.post(`${PATH}/add/notes`, Middleware.storeNotesValidation, FaceMiddleware.gate("store-notes"), Controller.storeNotes);
    server.post(`${PATH}/add/credit-card`, Middleware.storeCreditCardValidation, FaceMiddleware.gate("store-credit-card"), Controller.storeCreditCard);

    server.get(`${PATH}/limits`, Middleware.limitsValidation, Controller.getVaultLimits);
    server.post(`${PATH}/slots`, Middleware.purchaseSlotValidation, Controller.purchaseExtraSlot);

    server.get(`${PATH}/list`, Middleware.listValidation, Controller.listData);
    server.get(`${PATH}/proof`, Middleware.proofValidation, Controller.getProof);
    server.get(`${PATH}/list-all`, Middleware.listAllValidation, Controller.listAllData);
    server.get(`${PATH}/summary`, Middleware.summaryValidation, Controller.summarizeData);
    server.post(`${PATH}/retrieve`, Middleware.retrieveValidation, FaceMiddleware.gate("retrieve"), Controller.retrieveData);
    server.post(`${PATH}/preview`, Middleware.previewValidation, FaceMiddleware.gate("preview"), Controller.previewData);
    server.post(`${PATH}/change-master-password`, Middleware.changeMasterPasswordValidation, FaceMiddleware.gate("change-master-password"), Controller.changeMasterPassword);

    server.put(`${PATH}/delete/:id`, Middleware.deleteZelfKeyValidation, FaceMiddleware.gate("delete"), Controller.deleteZelfKey);

    // admin endpoints
    server.get(`${PATH}/dashboard/list`, Middleware.listDashboardValidation, Controller.listDataDashboard);
    server.get(`${PATH}/dashboard/list-all`, Middleware.listAllDashboardValidation, Controller.listAllDataDashboard);
    // Domain-wide admin list (license owner / staff of the domain). Metadata only, paginated.
    server.get(`${PATH}/dashboard/domain`, Middleware.domainListValidation, Controller.listDomainKeys);
};
