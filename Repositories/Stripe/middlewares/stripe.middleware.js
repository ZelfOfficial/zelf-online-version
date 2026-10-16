const Stripe = require("stripe");
const config = require("../../../Core/config");

/**
 * Validate Stripe webhook signature
 * This ensures the webhook request is actually from Stripe
 */
const webhookValidation = async (ctx, next) => {
	try {
		const signature = ctx.request.headers["stripe-signature"];

		if (!signature) {
			ctx.status = 400;
			ctx.body = { error: "Missing stripe-signature header" };
			return;
		}

		// Get webhook secret from environment
		const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

		if (!webhookSecret) {
			console.error("STRIPE_WEBHOOK_SECRET not configured");
			ctx.status = 500;
			ctx.body = { error: "Webhook secret not configured" };
			return;
		}

		// Get Stripe client
		const stripe = Stripe(config.stripe.secretKey);

		// Get the raw request body - this is critical for signature verification
		let requestBody;

		// Try to get raw body first
		if (ctx.request.rawBody) {
			requestBody = ctx.request.rawBody;
		} else if (ctx.request.body && typeof ctx.request.body === "string") {
			requestBody = ctx.request.body;
		} else {
			// Fallback: stringify the parsed body
			requestBody = JSON.stringify(ctx.request.body);
		}

		// Use Stripe's official webhook verification
		let event;
		try {
			event = stripe.webhooks.constructEvent(requestBody, signature, webhookSecret);
		} catch (err) {
			// 400, not 200: a 2xx tells Stripe the event was delivered, so it never retried and the
			// event was lost. Log only the error kind; never the secret, the header or the payload.
			const reason = String(err?.message || "").split("\n")[0].slice(0, 200);
			console.error("Stripe webhook signature verification failed:", err?.type || "Error", reason);

			ctx.status = 400;

			ctx.body = { error: "invalid_signature" };

			return;
		}

		// Attach the verified event to the context for the controller
		ctx.webhookEvent = event;

		// Proceed to next middleware
		await next();
	} catch (error) {
		console.error("Webhook validation error:", error);
		ctx.status = 400;
		ctx.body = { error: "Webhook validation failed" };
	}
};

module.exports = {
	webhookValidation,
};
