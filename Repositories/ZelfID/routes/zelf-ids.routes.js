const config = require("../../../Core/config");

const Controller = require("../controllers/zelf-id.controller");

const Middleware = require("../middlewares/zelf-id.middleware");
const FaceMiddleware = require("../../Face/middlewares/face.middleware");
const RbacMiddleware = require("../../Tags/middlewares/rbac.middleware");

const base = "/zelf-ids";
//v4


module.exports = (server) => {
    const PATH = config.basePath(base);

    server.get(`${PATH}/domains`, Controller.getDomains);

    server.get(`${PATH}/domains/:domain`, Controller.getDomain);

    server.get(`${PATH}/search`, Middleware.getValidation, Controller.searchTag);

    server.get(`${PATH}/search-by-domain`, Middleware.searchByDomainValidation, Controller.searchTagsByDomain);

    server.get(`${PATH}/preview`, Middleware.previewValidation, Controller.previewTag);

    server.get(`${PATH}/wallet-balances`, Middleware.walletBalancesValidation, Controller.getWalletBalances);

    server.get(`${PATH}/payment-options`, Middleware.paymentOptionsValidation, Middleware.paymentOptionsReducedFeeGate, Controller.paymentOptions);

    server.post(`${PATH}/payment-confirmation`, Middleware.paymentConfirmationValidation, Controller.paymentConfirmation);

    server.post(
        `${PATH}/smart-contract-payment-confirmation`,
        Middleware.smartContractPaymentConfirmationValidation,
        Controller.smartContractPaymentConfirmation
    );

    server.post(`${PATH}/stripe-checkout`, Middleware.stripeCheckoutValidation, Controller.stripeCheckout);

    server.get(`${PATH}/stripe-session`, Middleware.stripeSessionValidation, Controller.stripeSession);

    server.post(`${PATH}/lease`, Middleware.leaseValidation, FaceMiddleware.gate("lease"), Controller.leaseTag);

    server.post(`${PATH}/lease-offline`, Middleware.leaseOfflineValidation, Controller.leaseOffline);

    server.post(`${PATH}/sync-addresses`, Middleware.syncAddressesValidation, Controller.syncAddresses);

    server.post(`${PATH}/lease-recovery`, Middleware.leaseRecoveryValidation, FaceMiddleware.gate("lease-recovery"), Controller.leaseRecovery);

    server.delete(`${PATH}/delete`, Middleware.deleteTagValidation, FaceMiddleware.gate("delete"), Controller.deleteTag);

    server.post(`${PATH}/preview-zelfproof`, Middleware.previewZelfProofValidation, Controller.previewZelfProof);

    server.post(`${PATH}/preview-zelf-id-qr`, Middleware.previewZelfIdQrValidation, Controller.previewZelfIdQr);

    server.post(`${PATH}/decrypt`, Middleware.decryptValidation, FaceMiddleware.gate("decrypt"), Controller.decryptTag);

    // POST revenue-cat is registered on the unprotected router (static Authorization, no JWT):
    // see zelf-ids-revenue-cat.routes.js

    server.post(`${PATH}/purchase-rewards`, Middleware.referralRewardsValidation, Controller.purchaseRewards);

    server.post(`${PATH}/referral-rewards`, Middleware.referralRewardsValidation, Controller.referralRewards);

    server.post(`${PATH}/email-receipt`, Middleware.receiptEmailValidation, Controller.receiptEmail);

    server.post(
        `${PATH}/custom-extend`,
        Middleware.extendLicenseForOwnerValidation,
        FaceMiddleware.gate("my-tags-extend"),
        RbacMiddleware.requireWrite,
        Controller.extendLicenseForOwner,
    );
};
