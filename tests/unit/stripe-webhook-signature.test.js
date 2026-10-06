/**
 * Stripe webhook signature check (2026-10-01 audit). A real Koa app with the app's body parser
 * and the real Stripe verification, served in-process by supertest. Stripe itself is never
 * called: the signatures are made locally with a test secret.
 */
const Koa = require("koa");
const Router = require("@koa/router");
const request = require("supertest");
const Stripe = require("stripe");
const { createBodyParser, RAW_BODY_PATHS } = require("../../Core/request-body");
const { webhookValidation } = require("../../Repositories/Stripe/middlewares/stripe.middleware");

const SECRET = "whsec_unit_test_secret_0123456789";
const WEBHOOK_PATH = "/api/stripe/webhook";

// Stripe sends pretty-printed JSON: re-serializing the parsed body never reproduces these bytes.
const payload = JSON.stringify(
	{ id: "evt_unit_1", object: "event", type: "invoice.paid", data: { object: { id: "in_unit_1", amount_paid: 9900 } } },
	null,
	2
);
const signatureFor = (body, secret = SECRET) => Stripe.webhooks.generateTestHeaderString({ payload: body, secret });

let received;
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
	received = [];
	jest.spyOn(console, "error").mockImplementation(() => {});

	const router = new Router();
	router.post(WEBHOOK_PATH, webhookValidation, async (ctx) => {
		received.push(ctx.webhookEvent);
		ctx.body = { received: true };
	});
	router.post("/api/echo", async (ctx) => {
		ctx.body = { body: ctx.request.body, hasRaw: ctx.request.rawBody !== undefined };
	});

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

test("the webhook route is the one that keeps the raw body", () => {
	expect(RAW_BODY_PATHS).toEqual([WEBHOOK_PATH]);
});

test("a genuine Stripe event is verified against the bytes received", async () => {
	const response = await post(payload, signatureFor(payload));

	expect(response.status).toBe(200);
	expect(received).toHaveLength(1);
	expect(received[0]).toMatchObject({ id: "evt_unit_1", type: "invoice.paid" });
});

test.each([
	["a tampered payload", () => [payload.replace("9900", "1"), signatureFor(payload)]],
	["a signature made with another secret", () => [payload, signatureFor(payload, "whsec_someone_else")]],
	["a malformed signature header", () => [payload, "t=1,v1=nothex"]],
])("%s is refused with 400 so Stripe retries", async (_name, make) => {
	const [body, signature] = make();

	const response = await post(body, signature);

	expect(response.status).toBe(400);
	expect(response.body).toEqual({ error: "invalid_signature" });
	expect(received).toHaveLength(0);
});

test("a missing signature header is refused with 400", async () => {
	const response = await post(payload);

	expect(response.status).toBe(400);
	expect(received).toHaveLength(0);
});

test("a refused signature never logs the secret, the header or the payload", async () => {
	const signature = signatureFor(payload, "whsec_someone_else");

	await post(payload.replace("9900", "1"), signature);

	const logged = console.error.mock.calls.flat().map(String).join(" ");
	expect(logged).toContain("Stripe webhook signature verification failed");
	expect(logged).not.toContain(SECRET);
	expect(logged).not.toContain("whsec_");
	expect(logged).not.toContain(signature);
	expect(logged).not.toContain("in_unit_1");
});

test("other routes are parsed as before, without keeping a raw copy", async () => {
	const response = await request(app.callback()).post("/api/echo").send({ hello: "world" });

	expect(response.status).toBe(200);
	expect(response.body).toEqual({ body: { hello: "world" }, hasRaw: false });
});
