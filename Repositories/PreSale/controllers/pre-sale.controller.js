const Module = require("../modules/pre-sale.module");
const { errorHandler } = require("../../../Core/http-handler");
const { isValidCheckoutSessionId } = require("../../Stripe/modules/stripe-checkout-session.module");

/**
 * Handle request to create a pre-sale checkout session
 */
const createSession = async (ctx) => {
    try {
        const { amount, email, method, zelfName, solanaAddress } = ctx.request.body;

        // Basic validation
        if (!amount) {
            ctx.status = 400;
            ctx.body = { error: "Missing required parameter: amount" };
            return;
        }

        // Validate amount range (must match frontend config)
        const MIN_PURCHASE = 20;
        const MAX_PURCHASE = 10000;

        if (amount < MIN_PURCHASE || amount > MAX_PURCHASE) {
            ctx.status = 400;
            ctx.body = { error: `Amount must be between $${MIN_PURCHASE} and $${MAX_PURCHASE.toLocaleString()}` };
            return;
        }

        if (method === "coinbase") {
            ctx.status = 400;
            ctx.body = { error: "Coinbase payments are no longer supported" };
            return;
        }

        const sessionData = await Module.createStripeSession({
            amount: parseFloat(amount),
            email,
            zelfName,
            solanaAddress,
        });

        ctx.body = {
            success: true,
            data: sessionData,
        };
    } catch (error) {
        console.error("Controller Error:", error);
        ctx.status = error.status || 500;
        ctx.body = { error: error.message || "Internal Server Error" };
    }
};

const sendReceipt = async (ctx) => {
    try {
        const { email, amount, tokens, transactionId } = ctx.request.body;

        if (!email || !amount) {
            ctx.status = 400;
            ctx.body = { error: "Missing required parameters" };
            return;
        }

        await Module.sendReceiptEmail({
            email,
            amount,
            tokens,
            transactionId,
            date: new Date(),
        });

        ctx.body = { success: true };
    } catch (error) {
        console.error("Receipt Error:", error);
        ctx.status = error.status || 500;
        ctx.body = { error: error.message };
    }
};

/**
 * Public presale snapshot, including the current ZNS token USD price.
 */
const getPresaleInfo = async (ctx) => {
    try {
        ctx.body = {
            success: true,
            data: Module.getPresaleInfo(),
        };
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;
        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

const getSessionDetails = async (ctx) => {
    try {
        const raw = ctx.query?.sessionId;
        const sessionId = typeof raw === "string" ? raw.trim() : raw;

        if (!sessionId) {
            ctx.status = 400;
            ctx.body = { message: "Missing sessionId parameter", code: "invalid_session_id" };
            return;
        }

        if (!isValidCheckoutSessionId(sessionId)) {
            ctx.status = 400;
            ctx.body = { message: "Checkout session id format is invalid", code: "invalid_session_id" };
            return;
        }

        const details = await Module.getPaymentDetails(sessionId);

        ctx.body = {
            success: true,
            data: details,
        };
    } catch (error) {
        console.error("Session Details Error:", error);

        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;
        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

module.exports = {
    createSession,
    sendReceipt,
    getPresaleInfo,
    getSessionDetails,
};
