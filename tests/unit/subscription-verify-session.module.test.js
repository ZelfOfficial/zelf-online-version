const mockRetrieveCheckoutSession = jest.fn();

jest.mock("../../Repositories/Stripe/modules/stripe-checkout-session.module", () => {
	const actual = jest.requireActual("../../Repositories/Stripe/modules/stripe-checkout-session.module");
	return {
		...actual,
		retrieveCheckoutSession: (...args) => mockRetrieveCheckoutSession(...args),
	};
});

jest.mock("../../Repositories/License/modules/license.module", () => ({
	getMyLicense: jest.fn(),
}));

jest.mock("stripe", () =>
	jest.fn().mockImplementation(() => ({
		subscriptions: { retrieve: jest.fn() },
		customers: { retrieve: jest.fn() },
		invoices: { retrieve: jest.fn() },
	}))
);

const { stripeClientError } = require("../../Repositories/Stripe/modules/stripe-checkout-session.module");
const { getMyLicense } = require("../../Repositories/License/modules/license.module");
const { verifySession } = require("../../Repositories/SubscriptionPlan/modules/subscription-plan.module");

const VALID_SESSION_ID = "cs_test_verifyflow01";

describe("subscription-plan verifySession", () => {
	beforeEach(() => {
		process.env.STRIPE_SECRET_KEY = "sk_test_mock";
		mockRetrieveCheckoutSession.mockReset();
		getMyLicense.mockReset();
	});

	test("returns 400 when the auth token has no account email before Stripe or license lookup", async () => {
		await expect(verifySession(VALID_SESSION_ID, { identifier: "anon" })).rejects.toMatchObject({
			clientCode: "account_email_required",
		});

		expect(mockRetrieveCheckoutSession).not.toHaveBeenCalled();
		expect(getMyLicense).not.toHaveBeenCalled();
	});

	test("returns 404 session_not_found from Stripe before loading the license", async () => {
		mockRetrieveCheckoutSession.mockRejectedValue(
			stripeClientError(404, "session_not_found", "Checkout session not found")
		);

		await expect(verifySession(VALID_SESSION_ID, { email: "owner@example.com" })).rejects.toMatchObject({
			clientCode: "session_not_found",
		});

		expect(getMyLicense).not.toHaveBeenCalled();
	});
});
