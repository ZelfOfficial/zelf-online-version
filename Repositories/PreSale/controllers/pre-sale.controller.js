const Module = require("../modules/pre-sale.module");
const { respondStripeMoved } = require("../../Stripe/stripe-moved");

/**
 * Stripe checkout for the pre-sale now lives on v4.
 */
const createSession = async (ctx) => {
    respondStripeMoved(ctx);
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
 * Stripe session details for the pre-sale now live on v4.
 */
const getSessionDetails = async (ctx) => {
    respondStripeMoved(ctx);
};

module.exports = {
    createSession,
    sendReceipt,
    getSessionDetails,
};
