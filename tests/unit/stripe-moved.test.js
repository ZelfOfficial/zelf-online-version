const { respondStripeMoved, STRIPE_MOVED_TO_V4 } = require("../../Repositories/Stripe/stripe-moved");

describe("stripe moved to v4", () => {
	it("responds with HTTP 410 and STRIPE_MOVED_TO_V4", () => {
		const ctx = {};

		respondStripeMoved(ctx);

		expect(ctx.status).toBe(410);
		expect(ctx.body.code).toBe(STRIPE_MOVED_TO_V4);
		expect(ctx.body.error).toBe("STRIPE_MOVED_TO_V4");
	});
});
