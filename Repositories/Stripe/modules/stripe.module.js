const Stripe = require("stripe");
const config = require("../../../Core/config");
const IPFSModule = require("../../IPFS/modules/ipfs.module");
const { saveSubscriptionRecord } = require("../../License/modules/license.module");
const { tryGrantMonthlyZnsForPaidInvoice } = require("../../SubscriptionPlan/modules/subscription-zns-grant.module");

// Metadata `source` values Zelf writes. The Stripe account is shared with Verifik, so an
// invoice without one of these is Zelf's only when its customer email matches an account.
const ZELF_EVENT_SOURCES = new Set(["extension", "ios", "android", "zelf-id-lease", "dashboard"]);

/**
 * Get Stripe client instance
 */
const getStripeClient = () => {
    return Stripe(config.stripe.secretKey);
};

/**
 * Process Stripe webhook events
 * Handles the most common payment completion events
 */
const processWebhookEvent = async (event) => {
    const stripe = getStripeClient();

    try {
        switch (event.type) {
            case "invoice.payment_succeeded":
                return await handleInvoicePaymentSucceeded(event.data.object, stripe);

            case "invoice.payment_failed":
                return await handleInvoicePaymentFailed(event.data.object, stripe);

            case "customer.subscription.created":
                return { not_implemented: true };
                return await handleSubscriptionCreated(event.data.object, stripe);

            case "customer.subscription.updated":
                return { not_implemented: true };
                return await handleSubscriptionUpdated(event.data.object, stripe);

            case "customer.subscription.deleted":
                return { not_implemented: true };
                return await handleSubscriptionDeleted(event.data.object, stripe);

            case "checkout.session.completed":
                return { not_implemented: true };
                return await handleCheckoutSessionCompleted(event.data.object, stripe);

            case "payment_intent.succeeded":
                return { not_implemented: true };
                return await handlePaymentIntentSucceeded(event.data.object, stripe);

            case "payment_intent.payment_failed":
                return { not_implemented: true };
                return await handlePaymentIntentFailed(event.data.object, stripe);

            default:
                return { status: "unhandled", eventType: event.type };
        }
    } catch (error) {
        console.error(`Error processing webhook event ${event.type}:`, error);
        throw error;
    }
};

/**
 * Handle successful invoice payment
 */
const handleInvoicePaymentSucceeded = async (invoice, stripe) => {
    try {
        if (!invoice.subscription) {
            console.warn("[stripe webhook] invoice.payment_succeeded without subscription id:", invoice.id);
            return { status: "skipped", action: "invoice_payment_succeeded", reason: "no_subscription_on_invoice" };
        }

        const subscription = await stripe.subscriptions.retrieve(invoice.subscription, {
            expand: ["items.data.price"],
        });

        const customer = await stripe.customers.retrieve(invoice.customer);
        const source = subscription?.metadata?.source || invoice.metadata?.source || null;
        const zelfOwned = ZELF_EVENT_SOURCES.has(source);

        // No Zelf source and no Zelf account: this invoice belongs to the other product on the
        // shared Stripe account. Acknowledge it. A Zelf-sourced invoice, or a failed lookup,
        // still throws so Stripe retries.
        if (!customer?.email) {
            if (zelfOwned) throw new Error("404:account_not_found");

            return { ignored: true, reason: "account_not_found" };
        }

        const accountsWithSameEmail = await IPFSModule.get({
            key: "accountEmail",
            value: customer.email,
            throwOnError: true,
        });

        if (!accountsWithSameEmail?.length) {
            if (zelfOwned) throw new Error("404:account_not_found");

            return { ignored: true, reason: "account_not_found" };
        }

        const paymentData = {
            invoiceId: invoice.id,
            subscriptionId: invoice.subscription,
            customerId: invoice.customer,
            customerEmail: customer.email,
            amountPaid: invoice.amount_paid,
            paidAt: new Date(invoice.status_transitions.paid_at * 1000),
            currency: invoice.currency,
            status: "paid",
            subscription,
            customer,
            priceId: subscription.items?.data?.[0]?.price?.id,
        };

        const licensesWithSameEmail = await IPFSModule.get({
            key: "licenseOwner",
            value: customer.email,
            throwOnError: true,
        });

        await saveSubscriptionRecord(licensesWithSameEmail[0], paymentData);

        const znsGrant = await tryGrantMonthlyZnsForPaidInvoice({
            invoiceId: invoice.id,
            subscriptionId: invoice.subscription,
            customerEmail: customer.email,
            subscription,
            amountPaid: invoice.amount_paid,
        });

        return { status: "success", action: "invoice_payment_succeeded", data: paymentData, znsGrant };
    } catch (error) {
        console.error("Error handling invoice payment succeeded:", error);
        throw error;
    }
};

/**
 * Handle failed invoice payment
 */
const handleInvoicePaymentFailed = async (invoice, stripe) => {
    try {
        const paymentData = {
            invoiceId: invoice.id,
            subscriptionId: invoice.subscription,
            customerId: invoice.customer,
            amountDue: invoice.amount_due,
            currency: invoice.currency,
            status: "failed",
            failedAt: new Date(),
        };

        return { status: "success", action: "invoice_payment_failed", data: paymentData };
    } catch (error) {
        console.error("Error handling invoice payment failed:", error);
        throw error;
    }
};

/**
 * Handle subscription creation
 */
const handleSubscriptionCreated = async (subscription, stripe) => {
    try {
        const subscriptionData = {
            subscriptionId: subscription.id,
            customerId: subscription.customer,
            status: subscription.status,
            currentPeriodStart: new Date(subscription.current_period_start * 1000),
            currentPeriodEnd: new Date(subscription.current_period_end * 1000),
            createdAt: new Date(subscription.created * 1000),
        };

        return { status: "success", action: "subscription_created", data: subscriptionData };
    } catch (error) {
        console.error("Error handling subscription created:", error);
        throw error;
    }
};

/**
 * Handle subscription updates
 */
const handleSubscriptionUpdated = async (subscription, stripe) => {
    try {
        const subscriptionData = {
            subscriptionId: subscription.id,
            customerId: subscription.customer,
            status: subscription.status,
            currentPeriodStart: new Date(subscription.current_period_start * 1000),
            currentPeriodEnd: new Date(subscription.current_period_end * 1000),
        };

        return { status: "success", action: "subscription_updated", data: subscriptionData };
    } catch (error) {
        console.error("Error handling subscription updated:", error);
        throw error;
    }
};

/**
 * Handle subscription deletion/cancellation
 */
const handleSubscriptionDeleted = async (subscription, stripe) => {
    console.log("Subscription deleted:", subscription.id);

    try {
        const subscriptionData = {
            subscriptionId: subscription.id,
            customerId: subscription.customer,
            status: subscription.status,
            canceledAt: subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : null,
        };

        console.log("Subscription deleted:", subscriptionData);
        return { status: "success", action: "subscription_deleted", data: subscriptionData };
    } catch (error) {
        console.error("Error handling subscription deleted:", error);
        throw error;
    }
};

/**
 * Handle checkout session completion
 */
const handleCheckoutSessionCompleted = async (session, stripe) => {
    console.log("Checkout session completed:", session.id);

    try {
        const sessionData = {
            sessionId: session.id,
            customerId: session.customer,
            customerEmail: session.customer_email,
            subscriptionId: session.subscription,
            paymentStatus: session.payment_status,
            amountTotal: session.amount_total,
            currency: session.currency,
            completedAt: new Date(),
        };

        // TODO: Process completed checkout session
        // TODO: Update user subscription status
        // TODO: Send welcome email

        console.log("Checkout session completed:", sessionData);
        return { status: "success", action: "checkout_session_completed", data: sessionData };
    } catch (error) {
        console.error("Error handling checkout session completed:", error);
        throw error;
    }
};

/**
 * Handle successful payment intent
 */
const handlePaymentIntentSucceeded = async (paymentIntent, stripe) => {
    console.log("Payment intent succeeded:", paymentIntent.id);

    try {
        const paymentData = {
            paymentIntentId: paymentIntent.id,
            customerId: paymentIntent.customer,
            amount: paymentIntent.amount,
            currency: paymentIntent.currency,
            status: paymentIntent.status,
            succeededAt: new Date(),
        };

        // TODO: Process successful payment intent
        // TODO: Update payment status

        console.log("Payment intent succeeded:", paymentData);
        return { status: "success", action: "payment_intent_succeeded", data: paymentData };
    } catch (error) {
        console.error("Error handling payment intent succeeded:", error);
        throw error;
    }
};

/**
 * Handle failed payment intent
 */
const handlePaymentIntentFailed = async (paymentIntent, stripe) => {
    console.log("Payment intent failed:", paymentIntent.id);

    try {
        const paymentData = {
            paymentIntentId: paymentIntent.id,
            customerId: paymentIntent.customer,
            amount: paymentIntent.amount,
            currency: paymentIntent.currency,
            status: paymentIntent.status,
            failureCode: paymentIntent.last_payment_error?.code,
            failureMessage: paymentIntent.last_payment_error?.message,
            failedAt: new Date(),
        };

        // TODO: Process failed payment intent
        // TODO: Handle payment failure

        console.log("Payment intent failed:", paymentData);
        return { status: "success", action: "payment_intent_failed", data: paymentData };
    } catch (error) {
        console.error("Error handling payment intent failed:", error);
        throw error;
    }
};

module.exports = {
    processWebhookEvent,
};
