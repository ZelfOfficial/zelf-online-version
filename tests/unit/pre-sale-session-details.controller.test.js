const mockGetPaymentDetails = jest.fn();

jest.mock("../../Repositories/PreSale/modules/pre-sale.module", () => ({
	getPaymentDetails: (...args) => mockGetPaymentDetails(...args),
}));

const { errorHandler } = require("../../Core/http-handler");
const { stripeClientError } = require("../../Repositories/Stripe/modules/stripe-checkout-session.module");
const { getSessionDetails } = require("../../Repositories/PreSale/controllers/pre-sale.controller");

const VALID_SESSION_ID = "cs_test_presaleflow1";

describe("pre-sale getSessionDetails", () => {
	beforeEach(() => {
		mockGetPaymentDetails.mockReset();
	});

	test("returns 400 for malformed session ids", async () => {
		const ctx = { query: { sessionId: "not-a-stripe-id" } };

		await getSessionDetails(ctx);

		expect(ctx.status).toBe(400);
		expect(ctx.body).toEqual({
			message: "Checkout session id format is invalid",
			code: "invalid_session_id",
		});
		expect(mockGetPaymentDetails).not.toHaveBeenCalled();
	});

	test("maps Stripe session_not_found through errorHandler instead of HTTP 500", async () => {
		mockGetPaymentDetails.mockRejectedValue(stripeClientError(404, "session_not_found", "Checkout session not found"));

		const ctx = { query: { sessionId: VALID_SESSION_ID } };

		await getSessionDetails(ctx);

		const expected = errorHandler(stripeClientError(404, "session_not_found", "Checkout session not found"));

		expect(ctx.status).toBe(404);
		expect(ctx.body).toEqual({ message: expected.message, code: expected.code });
	});
});
