const config = require("../../../Core/config");

const Controller = require("../controllers/zns.controller");

const Middleware = require("../middlewares/zns.middleware");
const FaceMiddleware = require("../../Face/middlewares/face.middleware");

const base = "/zelf-name-service";

module.exports = (server) => {
	const PATH = config.basePath(base);

	// Route definitions
	server.get(`${PATH}/v2/search`, Middleware.getValidation, Controller.searchZelfName_v2);
	server.post(`${PATH}/v2/search`, Middleware.getValidation, Controller.searchZelfName_v2);
	server.post(`${PATH}/v2/lease`, Middleware.leaseValidation, FaceMiddleware.gate("zns-lease"), Controller.leaseZelfName_v2);
	server.post(`${PATH}/v2/lease-recovery`, Middleware.leaseRecoveryValidation, FaceMiddleware.gate("lease-recovery"), Controller.leaseRecovery);

	server.post(`${PATH}/v2/lease-offline`, Middleware.leaseOfflineValidation, Controller.leaseOfflineZelfName_v2);
	server.post(`${PATH}/v2/lease-confirmation`, Middleware.leaseConfirmationValidation, Controller.leaseConfirmation_v2);
	server.post(`${PATH}/v2/preview`, Middleware.previewValidation, Controller.previewZelfName_v2);
	server.post(`${PATH}/preview-zelfproof`, Middleware.previewZelfProofValidation, Controller.previewZelfProof);
	server.post(`${PATH}/v2/decrypt`, Middleware.decryptValidation, FaceMiddleware.gate("zns-decrypt"), Controller.decryptZelfName_v2);
	server.post(`${PATH}/revenue-cat`, Middleware.revenueCatWebhookValidation, Controller.revenueCatWebhook);
	server.post(`${PATH}/purchase-rewards`, Middleware.referralRewardsValidation, Controller.purchaseRewards);
	server.post(`${PATH}/referral-rewards`, Middleware.referralRewardsValidation, Controller.referralRewards);
	server.put(`${PATH}/:zelfName`, Middleware.updateValidation, Controller.update);
};
