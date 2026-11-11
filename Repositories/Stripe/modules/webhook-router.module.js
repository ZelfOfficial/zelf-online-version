const Stripe = require("stripe");

const config = require("../../../Core/config");
const StripeModule = require("./stripe.module");

// Loaded only for Zelf Keys app events. Verifik events on the shared Stripe account never reach it.
const subscriptionModule = () => require("../../ZelfKeysSubscription/modules/zelf-keys-subscription.module");

/**
 * Get Stripe client instance
 */
const getStripeClient = () => {
	return Stripe(config.stripe.secretKey);
};

/**
 * Get webhook source from event metadata
 * @param {Object} event - Stripe webhook event
 * @returns {Promise<string>} - Source identifier: 'extension'|'ios'|'android'|'dashboard'|null
 */
const getWebhookSource = async (event) => {
	const stripe = getStripeClient();

	let source = null;

	try {
		switch (event.type) {
			case "checkout.session.completed":
			case "checkout.session.async_payment_succeeded":
			case "checkout.session.async_payment_failed":
				source = event.data.object.metadata?.source;

				break;
			case "customer.subscription.created":
			case "customer.subscription.updated":
			case "customer.subscription.deleted":
				source = event.data.object.metadata?.source;

				break;
			case "invoice.payment_succeeded":
			case "invoice.payment_failed":
			case "invoice.payment_action_required":
				if (event.data.object.subscription) {
					try {
						const subscription = await stripe.subscriptions.retrieve(event.data.object.subscription);

						source = subscription.metadata?.source;
					} catch (error) {
						console.error("Error retrieving subscription for invoice event:", error);

						source = event.data.object.metadata?.source;
					}
				} else {
					source = event.data.object.metadata?.source;
				}

				break;
			default:
				source = source || event.data?.object?.metadata?.source || null;

				break;
		}
	} catch (error) {
		console.error("Error getting webhook source:", error);
	}

	return source;
};

/**
 * Route webhook event to appropriate handler based on source
 * @param {Object} event - Stripe webhook event
 * @returns {Promise<Object>} - Handler result
 */
const routeWebhook = async (event) => {
	const presaleType = event?.data?.object?.metadata?.type;
	const presaleEvent = event?.type === "checkout.session.completed" || event?.type === "checkout.session.async_payment_succeeded";

	if (presaleEvent && presaleType === "zns_presale") {
		const PreSaleModule = require("../../PreSale/modules/pre-sale.module");
		return await PreSaleModule.fulfillFromVerifiedStripeEvent(event);
	}

	const source = await getWebhookSource(event);

	// Extension/app sources route to Subscription module
	if (source === "extension" || source === "ios" || source === "android") {
		return await subscriptionModule().webhookHandler(event);
	}

	if (source === "zelf-id-lease") {
		const ZelfIdsStripeModule = require("../../ZelfID/modules/zelf-ids-stripe.module");

		if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
			return await ZelfIdsStripeModule.confirmFromCheckoutEvent(event);
		}

		return { status: "skipped", reason: "unhandled_zelf_id_lease_event", eventType: event.type };
	}

	// Dashboard source or missing source routes to Stripe module (admin panel)
	return await StripeModule.processWebhookEvent(event);
};

module.exports = {
	getWebhookSource,
	routeWebhook,
};
