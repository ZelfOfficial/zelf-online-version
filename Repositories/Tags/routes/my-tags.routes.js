const config = require("../../../Core/config");

const Controller = require("../controllers/my-tags.controller");

const Middleware = require("../middlewares/my-tags.middleware");
const FaceMiddleware = require("../../Face/middlewares/face.middleware");

const RbacMiddleware = require("../middlewares/rbac.middleware");

const base = "/my-tags";

module.exports = (server) => {
    const PATH = config.basePath(base);

    // transfer tag
    server.post(`${PATH}/transfer`, Middleware.transferValidation, FaceMiddleware.gate("my-tags-transfer"), Controller.transferTag);

    // payment options
    server.get(
        `${PATH}/payment-options`,
        Middleware.paymentOptionsValidation,
        Middleware.paymentOptionsReducedFeeGate,
        Controller.paymentOptions,
    );

    // payment confirmation
    server.post(`${PATH}/payment-confirmation`, Middleware.paymentConfirmationValidation, Controller.paymentConfirmation);

    // Avalanche smart-contract payment confirmation (ZelfAvalanchePay)
    server.post(
        `${PATH}/smart-contract-payment-confirmation`,
        Middleware.smartContractPaymentConfirmationValidation,
        Controller.smartContractPaymentConfirmation
    );

    // receipt email
    server.post(`${PATH}/email-receipt`, Middleware.receiptEmailValidation, Controller.receiptEmail);

    // my referrals
    server.get(`${PATH}/referrals`, Middleware.referralsValidation, Controller.referrals);

    server.post(`${PATH}/referrals/claim`, Middleware.claimReferralValidation, Controller.claimReferralReward);

    // owner license extension (free)
    server.post(`${PATH}/custom-extend`, Middleware.extendLicenseForOwnerValidation, FaceMiddleware.gate("my-tags-extend"), RbacMiddleware.requireWrite, Controller.extendLicenseForOwner);
};




