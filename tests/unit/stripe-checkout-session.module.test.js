const {
	isValidCheckoutSessionId,
	throwMappedStripeRetrieveError,
	stripeClientError,
} = require("../../Repositories/Stripe/modules/stripe-checkout-session.module");

describe("stripe-checkout-session.module", () => {
	test("isValidCheckoutSessionId accepts Stripe-style checkout session ids", () => {
		expect(isValidCheckoutSessionId("cs_test_a1b2c3d4e5f6g7h8")).toBe(true);
		expect(isValidCheckoutSessionId("cs_live_abcdefghijklmnopqrst")).toBe(true);
	});

	test("isValidCheckoutSessionId rejects malformed ids", () => {
		expect(isValidCheckoutSessionId("")).toBe(false);
		expect(isValidCheckoutSessionId("pi_test_1234567890abcd")).toBe(false);
		expect(isValidCheckoutSessionId("cs_short")).toBe(false);
		expect(isValidCheckoutSessionId("cs_bad-chars!")).toBe(false);
	});

	test("throwMappedStripeRetrieveError maps resource_missing to session_not_found", () => {
		const stripeError = new Error("No such checkout.session");
		stripeError.type = "StripeInvalidRequestError";
		stripeError.code = "resource_missing";
		stripeError.statusCode = 404;

		expect(() => throwMappedStripeRetrieveError(stripeError)).toThrow(
			expect.objectContaining({
				clientCode: "session_not_found",
				message: "404:session_not_found",
			})
		);
	});

	test("throwMappedStripeRetrieveError maps auth errors to stripe_unavailable without leaking internals", () => {
		const stripeError = new Error("Invalid API Key provided: sk_live_secret");
		stripeError.type = "StripeAuthenticationError";

		try {
			throwMappedStripeRetrieveError(stripeError);
		} catch (error) {
			expect(error.clientCode).toBe("stripe_unavailable");
			expect(error.message).toBe("502:stripe_unavailable");
			expect(error.clientMessage).not.toMatch(/sk_live/);
		}
	});

	test("stripeClientError sets clientCode for errorHandler", () => {
		const error = stripeClientError(503, "stripe_unavailable", "Payment provider is busy");
		expect(error.clientCode).toBe("stripe_unavailable");
		expect(error.message).toBe("503:stripe_unavailable");
	});
});
