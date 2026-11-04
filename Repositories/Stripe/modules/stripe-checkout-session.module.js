const { string } = require("../../../Core/JoiUtils");

const CHECKOUT_SESSION_ID_MIN_LENGTH = 16;
const CHECKOUT_SESSION_ID_MAX_LENGTH = 255;
const CHECKOUT_SESSION_ID_REGEX = /^cs_[A-Za-z0-9_]+$/;

const isValidCheckoutSessionId = (sessionId) => {
    const id = String(sessionId ?? "").trim();
    if (!id) return false;
    if (id.length < CHECKOUT_SESSION_ID_MIN_LENGTH || id.length > CHECKOUT_SESSION_ID_MAX_LENGTH) return false;
    return CHECKOUT_SESSION_ID_REGEX.test(id);
};

const checkoutSessionIdJoi = () =>
    string()
        .required()
        .trim()
        .min(CHECKOUT_SESSION_ID_MIN_LENGTH)
        .max(CHECKOUT_SESSION_ID_MAX_LENGTH)
        .pattern(CHECKOUT_SESSION_ID_REGEX);

const stripeClientError = (status, code, clientMessage) => {
    const error = new Error(`${status}:${code}`);
    error.clientCode = code;
    error.clientMessage = clientMessage;
    return error;
};

/**
 * Map Stripe SDK errors to safe HTTP-facing errors (no secrets or raw Stripe internals).
 * @param {Error} error
 */
const throwMappedStripeRetrieveError = (error) => {
    const type = error?.type;
    const code = error?.code;
    const statusCode = error?.statusCode;

    if (type === "StripeInvalidRequestError" && (code === "resource_missing" || statusCode === 404)) {
        throw stripeClientError(404, "session_not_found", "Checkout session not found");
    }

    if (type === "StripeAuthenticationError") {
        throw stripeClientError(502, "stripe_unavailable", "Unable to verify payment session");
    }

    if (type === "StripeRateLimitError") {
        throw stripeClientError(503, "stripe_unavailable", "Payment provider is busy. Try again shortly");
    }

    if (type === "StripeConnectionError" || type === "StripeAPIError") {
        throw stripeClientError(503, "stripe_unavailable", "Unable to reach payment provider");
    }

    throw stripeClientError(502, "stripe_unavailable", "Unable to verify payment session");
};

/**
 * @param {import('stripe').Stripe} stripe
 * @param {string} sessionId
 * @param {object} [retrieveOptions]
 */
const retrieveCheckoutSession = async (stripe, sessionId, retrieveOptions) => {
    try {
        return await stripe.checkout.sessions.retrieve(sessionId, retrieveOptions);
    } catch (error) {
        throwMappedStripeRetrieveError(error);
    }
};

module.exports = {
    CHECKOUT_SESSION_ID_MIN_LENGTH,
    CHECKOUT_SESSION_ID_MAX_LENGTH,
    CHECKOUT_SESSION_ID_REGEX,
    isValidCheckoutSessionId,
    checkoutSessionIdJoi,
    retrieveCheckoutSession,
    throwMappedStripeRetrieveError,
    stripeClientError,
};
