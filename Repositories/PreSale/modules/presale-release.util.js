const PAYMENT_LOCK_UNAVAILABLE = "PAYMENT_LOCK_UNAVAILABLE";
const TOKENS_ALREADY_RELEASED = "TOKENS_ALREADY_RELEASED";
const RELEASE_SOURCE_VERIFIED_WEBHOOK = "verified_stripe_webhook";

const createCodedError = (code, status) => {
    const error = new Error(code);
    error.status = status;
    error.code = code;
    return error;
};

const lockUnavailableError = () => createCodedError(PAYMENT_LOCK_UNAVAILABLE, 409);

const tokensAlreadyReleasedError = () => createCodedError(TOKENS_ALREADY_RELEASED, 409);

const hasRecordedValue = (value) => typeof value === "string" && value.trim().length > 0;

/**
 * A token payout counts as done only when the released flag and the payout tx were stored together.
 */
const isTokenPayoutRecorded = ({ tokensReleased, payoutTx } = {}) => {
    return tokensReleased === true && hasRecordedValue(payoutTx);
};

/**
 * A license extension counts as done only when the extended flag and a recorded result were stored together.
 */
const isLicenseExtensionRecorded = ({ licenseExtended, licenseRecord } = {}) => {
    return licenseExtended === true && hasRecordedValue(licenseRecord);
};

const assertVerifiedReleaseSource = (source) => {
    if (source !== RELEASE_SOURCE_VERIFIED_WEBHOOK) {
        throw createCodedError("PRESALE_RELEASE_NOT_ALLOWED", 403);
    }
};

/**
 * Both members of each pair are set in the same object so they can be written in one update.
 * A flag is never persisted without its recorded result.
 */
const buildAtomicReleaseUpdate = ({ payoutTx, licenseRecord } = {}) => {
    const update = {};

    if (hasRecordedValue(payoutTx)) {
        update.tokensReleased = true;
        update.payoutTx = String(payoutTx).trim();
    }

    if (hasRecordedValue(licenseRecord)) {
        update.licenseExtended = true;
        update.licenseRecord = String(licenseRecord).trim();
    }

    return update;
};

module.exports = {
    PAYMENT_LOCK_UNAVAILABLE,
    TOKENS_ALREADY_RELEASED,
    RELEASE_SOURCE_VERIFIED_WEBHOOK,
    createCodedError,
    lockUnavailableError,
    tokensAlreadyReleasedError,
    isTokenPayoutRecorded,
    isLicenseExtensionRecorded,
    assertVerifiedReleaseSource,
    buildAtomicReleaseUpdate,
};
