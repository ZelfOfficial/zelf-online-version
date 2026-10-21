const mockRetrieve = jest.fn();

jest.mock("stripe", () => jest.fn().mockImplementation(() => ({
	checkout: {
		sessions: {
			retrieve: mockRetrieve,
		},
	},
})));

jest.mock("../../Repositories/Tags/config/supported-domains", () => ({
	getDomainConfig: jest.fn(),
}));

jest.mock("../../Core/config", () => ({
	stripe: { secretKey: "sk_test_mock" },
	JWT_SECRET: "test",
	landingUrl: "https://zelf.world",
	zelfProof: { url: "https://example.test", apiKey: "test" },
}));

const { confirmFromSessionId, buildLeaseStripeMetadata } = require("../../Repositories/ZelfID/modules/zelf-ids-stripe.module");
const { errorHandler } = require("../../Core/http-handler");

const VALID_SESSION_ID = "cs_test_confirmflow01";

describe("confirmFromSessionId", () => {
	beforeEach(() => {
		mockRetrieve.mockReset();
	});

	test("maps unknown Stripe session to 404 session_not_found", async () => {
		const stripeError = new Error("No such checkout.session");
		stripeError.type = "StripeInvalidRequestError";
		stripeError.code = "resource_missing";
		stripeError.statusCode = 404;
		mockRetrieve.mockRejectedValue(stripeError);

		const error = await confirmFromSessionId(VALID_SESSION_ID).catch((caught) => caught);

		expect(error).toMatchObject({ clientCode: "session_not_found" });

		const handled = errorHandler(error);
		expect(handled.status).toBe(404);
		expect(handled.code).toBe("session_not_found");
	});

	test("retrieves session and runs confirmPaidStripeSession for a valid paid lease session", async () => {
		const metadata = buildLeaseStripeMetadata({
			tagName: "qa99",
			domain: "zelf",
			duration: "1",
			plan: "unlimited",
			amountUsd: "36",
		});

		mockRetrieve.mockResolvedValue({
			id: VALID_SESSION_ID,
			metadata,
			payment_status: "unpaid",
		});

		const result = await confirmFromSessionId(VALID_SESSION_ID);

		expect(mockRetrieve).toHaveBeenCalledWith(VALID_SESSION_ID, undefined);
		expect(result).toEqual({
			status: "unpaid",
			reason: "unpaid",
			confirmed: false,
			tagName: "qa99",
			domain: "zelf",
			duration: "1",
			plan: "unlimited",
			amountUsd: "36",
		});
	});
});
