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

const jwt = require("jsonwebtoken");
const { confirmFromSessionId, buildLeaseStripeMetadata, pollStripeSession } = require("../../Repositories/ZelfID/modules/zelf-ids-stripe.module");
const { errorHandler } = require("../../Core/http-handler");

const VALID_SESSION_ID = "cs_test_confirmflow01";

describe("confirmFromSessionId", () => {
	beforeEach(() => {
		mockRetrieve.mockReset();
	});

	test("maps unknown Stripe session to 404 SESSION_NOT_FOUND", async () => {
		const stripeError = new Error("No such checkout.session");
		stripeError.type = "StripeInvalidRequestError";
		stripeError.code = "resource_missing";
		stripeError.statusCode = 404;
		mockRetrieve.mockRejectedValue(stripeError);

		const error = await confirmFromSessionId(VALID_SESSION_ID).catch((caught) => caught);

		expect(error).toMatchObject({ clientCode: "SESSION_NOT_FOUND" });

		const handled = errorHandler(error);
		expect(handled.status).toBe(404);
		expect(handled.code).toBe("SESSION_NOT_FOUND");
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
			reason: "UNPAID",
			confirmed: false,
			tagName: "qa99",
			domain: "zelf",
			duration: "1",
			plan: "unlimited",
			amountUsd: "36",
		});
	});
});

describe("pollStripeSession", () => {
	const metadata = buildLeaseStripeMetadata({
		tagName: "qa99",
		domain: "zelf",
		duration: "1",
		plan: "unlimited",
		amountUsd: "36",
	});

	beforeEach(() => {
		mockRetrieve.mockReset();
	});

	test("an unpaid poll returns only status when the caller does not own the name", async () => {
		mockRetrieve.mockResolvedValue({
			id: VALID_SESSION_ID,
			metadata,
			payment_status: "unpaid",
		});

		const result = await pollStripeSession({ sessionId: VALID_SESSION_ID, authUser: {}, token: "" });

		expect(result).toEqual({ confirmed: false });
	});

	test("an unpaid poll returns the quote fields to the checkout owner", async () => {
		mockRetrieve.mockResolvedValue({
			id: VALID_SESSION_ID,
			metadata,
			payment_status: "unpaid",
		});
		const token = jwt.sign({ tagName: "qa99.zelf", ttl: Math.floor(Date.now() / 1000) + 3600 }, "test");

		const result = await pollStripeSession({ sessionId: VALID_SESSION_ID, authUser: {}, token });

		expect(result).toMatchObject({
			status: "unpaid",
			confirmed: false,
			tagName: "qa99",
			domain: "zelf",
			plan: "unlimited",
		});
	});

	test("a paid poll does not grant when the caller does not own the name", async () => {
		mockRetrieve.mockResolvedValue({
			id: VALID_SESSION_ID,
			metadata,
			payment_status: "paid",
			created: Math.floor(Date.now() / 1000) - 60,
			amount_total: 3600,
		});

		const error = await pollStripeSession({ sessionId: VALID_SESSION_ID, authUser: {} }).catch((caught) => caught);

		expect(error).toMatchObject({ clientCode: "TAG_NOT_OWNED" });
		expect(mockRetrieve).toHaveBeenCalledTimes(1);
	});
});
