const Module = require("../modules/pre-sale.module");

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

const getSessionDetails = async (ctx) => {
    try {
        const { sessionId } = ctx.query; // GET request params

        if (!sessionId) {
            ctx.status = 400;
            ctx.body = { error: "Missing sessionId parameter" };
            return;
        }

        const details = await Module.getPaymentDetails(sessionId);

        ctx.body = {
            success: true,
            data: details,
        };
    } catch (error) {
        console.error("Session Details Error:", error);
        ctx.status = error.status || 500;
        ctx.body = {
            error: error.message,
            ...(error.code ? { code: error.code } : {}),
        };
    }
};

module.exports = {
    createSession,
    sendReceipt,
    getSessionDetails,
};
