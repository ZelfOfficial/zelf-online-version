const config = require("../../../Core/config");

const Controller = require("../controllers/zelf-id.controller");

const Middleware = require("../middlewares/zelf-id.middleware");

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

    server.post(`${PATH}/lease`, Middleware.leaseValidation, Controller.leaseTag);

    server.post(`${PATH}/lease-offline`, Middleware.leaseOfflineValidation, Controller.leaseOffline);

    server.post(`${PATH}/sync-addresses`, Middleware.syncAddressesValidation, Controller.syncAddresses);

    server.post(`${PATH}/lease-recovery`, Middleware.leaseRecoveryValidation, Controller.leaseRecovery);

    server.delete(`${PATH}/delete`, Middleware.deleteTagValidation, Controller.deleteTag);

    server.post(`${PATH}/preview-zelfproof`, Middleware.previewZelfProofValidation, Controller.previewZelfProof);

    server.post(`${PATH}/preview-zelf-id-qr`, Middleware.previewZelfIdQrValidation, Controller.previewZelfIdQr);

    server.post(`${PATH}/decrypt`, Middleware.decryptValidation, Controller.decryptTag);

    server.post(`${PATH}/revenue-cat`, Middleware.revenueCatWebhookValidation, Controller.revenueCatWebhook);

    server.post(`${PATH}/purchase-rewards`, Middleware.referralRewardsValidation, Controller.purchaseRewards);

    server.post(`${PATH}/referral-rewards`, Middleware.referralRewardsValidation, Controller.referralRewards);
};
