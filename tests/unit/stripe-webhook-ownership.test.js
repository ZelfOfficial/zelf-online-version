/**
 * Shared Stripe account: after a valid signature, events that are not Zelf's are
 * acknowledged with 200 so Stripe stops retrying them. A bad signature stays 400.
 * A Zelf ID checkout.session.completed is still handled by the lease confirmer.
 */
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_webhook_ownership_key";

// Importing the grant module builds a Solana public key. This file never grants ZNS.
jest.mock("../../Repositories/SubscriptionPlan/modules/subscription-zns-grant.module", () => ({
	tryGrantMonthlyZnsForPaidInvoice: jest.fn(),
}));

const configuration = require("../../Core/config");

if (!configuration.stripe.secretKey) configuration.stripe.secretKey = process.env.STRIPE_SECRET_KEY;

const Koa = require("koa");
const Router = require("@koa/router");
const request = require("supertest");
const Stripe = require("stripe");
const { createBodyParser } = require("../../Core/request-body");
const { webhookValidation } = require("../../Repositories/Stripe/middlewares/stripe.middleware");
const { handleWebhook, ignoredAcknowledgement } = require("../../Repositories/Stripe/controllers/stripe.controller");

const SECRET = "whsec_unit_test_secret_0123456789";
const WEBHOOK_PATH = "/api/stripe/webhook";

const pretty = (value) => JSON.stringify(value, null, 2);
const signatureFor = (body, secret = SECRET) => Stripe.webhooks.generateTestHeaderString({ payload: body, secret });

const foreignCustomer = pretty({
	id: "evt_foreign_customer",
	object: "event",
	type: "customer.created",
	data: { object: { id: "cus_foreign", object: "customer", email: "billing@verifik.example" } },
});

const foreignCheckout = pretty({
	id: "evt_foreign_checkout",
	object: "event",
	type: "checkout.session.completed",
	created: 1710000001,
	data: {
		object: {
			id: "cs_foreign",
			object: "checkout.session",
			metadata: { source: "verifik" },
			payment_status: "paid",
		},
	},
});

const zelfCheckout = pretty({
	id: "evt_zelf_checkout",
	object: "event",
	type: "checkout.session.completed",
	created: 1710000002,
	data: {
		object: {
			id: "cs_zelf",
			object: "checkout.session",
			payment_status: "unpaid",
			metadata: {
				source: "zelf-id-lease",
				type: "zelf_id_lease",
				tagName: "qa99",
				domain: "zelf",
				duration: "1",
				plan: "unlimited",
				amountUsd: "36",
			},
		},
	},
});

let app;
let previousSecret;

beforeAll(() => {
	previousSecret = process.env.STRIPE_WEBHOOK_SECRET;
	process.env.STRIPE_WEBHOOK_SECRET = SECRET;
});

afterAll(() => {
	if (previousSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
	else process.env.STRIPE_WEBHOOK_SECRET = previousSecret;
});

beforeEach(() => {
	jest.spyOn(console, "error").mockImplementation(() => {});
	jest.spyOn(console, "warn").mockImplementation(() => {});

	const router = new Router();
	router.post(WEBHOOK_PATH, webhookValidation, handleWebhook);

	app = new Koa();
	app.use(createBodyParser());
	app.use(router.routes());
});

afterEach(() => jest.restoreAllMocks());

const post = (body, signature) => {
	const call = request(app.callback()).post(WEBHOOK_PATH).set("Content-Type", "application/json");
	if (signature) call.set("Stripe-Signature", signature);
	return call.send(body);
};

test("a bad signature is still refused with 400", async () => {
	const response = await post(foreignCustomer, signatureFor(foreignCustomer, "whsec_someone_else"));

	expect(response.status).toBe(400);
	expect(response.body).toEqual({ error: "invalid_signature" });
	expect(console.warn).not.toHaveBeenCalled();
});

test("a missing signature is still refused with 400", async () => {
	const response = await post(foreignCustomer);

	expect(response.status).toBe(400);
	expect(response.body.error).toBeTruthy();
	expect(console.warn).not.toHaveBeenCalled();
});

test("an event type Zelf does not handle is acknowledged and ignored", async () => {
	const response = await post(foreignCustomer, signatureFor(foreignCustomer));

	expect(response.status).toBe(200);
	expect(response.body).toEqual({ received: true, ignored: true, reason: "unhandled_event_type" });

	const logged = console.warn.mock.calls.map((args) => args.map(String).join(" ")).join("\n");
	expect(logged).toContain("[stripe webhook] ignored customer.created evt_foreign_customer unhandled_event_type");
	expect(logged).not.toContain("billing@verifik.example");
	expect(console.error).not.toHaveBeenCalled();
});

test("a checkout.session.completed that is not Zelf's is ignored", async () => {
	const response = await post(foreignCheckout, signatureFor(foreignCheckout));

	expect(response.status).toBe(200);
	expect(response.body).toEqual({ received: true, ignored: true, reason: "unhandled_event_type" });
});

test("a Zelf checkout.session.completed is still processed", async () => {
	const response = await post(zelfCheckout, signatureFor(zelfCheckout));

	expect(response.status).toBe(200);
	expect(response.body.received).toBe(true);
	expect(response.body.ignored).toBeUndefined();
	expect(response.body.processed).toMatchObject({
		status: "unpaid",
		reason: "UNPAID",
		confirmed: false,
		tagName: "qa99",
		domain: "zelf",
		duration: "1",
		plan: "unlimited",
		amountUsd: "36",
	});
	expect(console.warn).not.toHaveBeenCalled();
});

test("an account miss is mapped to the ignore acknowledgement", () => {
	expect(ignoredAcknowledgement({ ignored: true, reason: "account_not_found" })).toEqual({
		received: true,
		ignored: true,
		reason: "account_not_found",
	});
	expect(ignoredAcknowledgement({ status: "success", action: "invoice_payment_succeeded" })).toBeNull();
});
