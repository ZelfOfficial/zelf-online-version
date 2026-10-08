// Live Zelf ID payment quotes and unpaid confirmation.
// Face: Core/assets/selfie_girl.jpg. Hits /api/zelf-ids (v4), not /api/my-tags.
//
// A completed-payment case is intentionally not fabricated here. Each quote creates
// fresh one-time deposit addresses and a session cutoff, so reaching `confirmed: true`
// requires sending real funds (or paying a live Stripe Checkout), waiting on external
// indexers, and then permanently rewriting IPFS/Arweave state. An old transaction
// cannot satisfy a fresh address/session, and injecting provider success would violate
// this repository's no-mocking policy. The deterministic tests below therefore cover
// signed-quote ownership/expiry gates and the real unpaid provider path.
const request = require("supertest");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const moment = require("moment");
require("dotenv").config();

const API_BASE_URL = `http://localhost:${process.env.PORT || 3000}`;
const ORIGIN = "https://test.example.com";
const ZELF_IDS_PATH = "/api/zelf-ids";
const TEST_DOMAIN = "zelf";
const TEST_PASSWORD = "testpassword123";
const selfieImagePath = path.resolve(__dirname, "../../Core/assets/selfie_girl.jpg");
const faceBase64 = fs.readFileSync(selfieImagePath, "base64");

const uniqueTagName = () => `zid${Math.floor(Math.random() * 100000).toString().padStart(5, "0")}`;
const shortUniqueTagName = () => `z${Math.floor(Math.random() * 10000).toString().padStart(4, "0")}`;
const { buildMetadata } = require("../../Repositories/ZelfID/modules/zelf-ids-payment.module");
const { resolvePaidExpiresAt } = require("../../Repositories/ZelfID/modules/zelf-id-plan.module");

describe("Zelf IDs payment API", () => {
	jest.setTimeout(180000);

	let authToken;
	let reservedName;
	let paymentQuote;
	const leasedLongNames = [];

	beforeAll(async () => {
		expect(fs.existsSync(selfieImagePath)).toBe(true);
		expect(faceBase64.length).toBeGreaterThan(1000);

		const sessionResponse = await request(API_BASE_URL)
			.post("/api/sessions")
			.set("Origin", ORIGIN)
			.send({
				identifier: `zelfids_pay_${Date.now()}_${Math.random().toString(36).substring(7)}`,
				type: "createWallet",
				isWebExtension: false,
			})
			.expect(200);

		authToken = sessionResponse.body.data.token;
		expect(authToken).toBeDefined();
	});

	afterAll(async () => {
		if (!authToken) return;
		const names = [...leasedLongNames, reservedName].filter(Boolean);
		await Promise.all(
			names.map((tagName) =>
				request(API_BASE_URL)
					.delete(`${ZELF_IDS_PATH}/delete`)
					.set("Origin", ORIGIN)
					.set("Authorization", `Bearer ${authToken}`)
					.send({
						tagName,
						domain: TEST_DOMAIN,
						faceBase64,
						password: TEST_PASSWORD,
					})
			)
		);
	});

	it("POST /zelf-ids/lease — selfie face creates a one-year paid reservation", async () => {
		reservedName = shortUniqueTagName();

		const leaseResponse = await request(API_BASE_URL)
			.post(`${ZELF_IDS_PATH}/lease`)
			.set("Origin", ORIGIN)
			.set("Authorization", `Bearer ${authToken}`)
			.send({
				tagName: reservedName,
				domain: TEST_DOMAIN,
				faceBase64,
				password: TEST_PASSWORD,
				type: "create",
				os: "DESKTOP",
				removePGP: true,
			});

		expect(leaseResponse.status).toBe(200);
		const publicData = leaseResponse.body.data.tagObject.publicData;
		expect(publicData.type).toBe("hold");
		expect(Number(publicData.v)).toBe(4);
		expect(publicData.origin).toBe("online");
		expect(leaseResponse.body.data.walrus).toBeFalsy();

		const yearsUntilExpiry = moment(publicData.expiresAt).diff(moment(), "year", true);
		expect(yearsUntilExpiry).toBeGreaterThanOrEqual(0.99);
		expect(yearsUntilExpiry).toBeLessThan(1.1);
	});

	it("GET /zelf-ids/payment-options — 401 without auth", async () => {
		const response = await request(API_BASE_URL)
			.get(`${ZELF_IDS_PATH}/payment-options`)
			.set("Origin", ORIGIN)
			.query({ tagName: reservedName, domain: TEST_DOMAIN, duration: "1" });

		expect(response.status).toBe(401);
	});

	it("GET /zelf-ids/payment-options — 409 without tagName/duration", async () => {
		const response = await request(API_BASE_URL)
			.get(`${ZELF_IDS_PATH}/payment-options`)
			.set("Origin", ORIGIN)
			.set("Authorization", `Bearer ${authToken}`);

		expect(response.status).toBe(409);
		expect(response.body).toHaveProperty("validationError");
	});

	it("GET /zelf-ids/payment-options — 404 when the name is not leased", async () => {
		const response = await request(API_BASE_URL)
			.get(`${ZELF_IDS_PATH}/payment-options`)
			.set("Origin", ORIGIN)
			.set("Authorization", `Bearer ${authToken}`)
			.query({ tagName: uniqueTagName(), domain: TEST_DOMAIN, duration: "1" });

		expect(response.status).toBe(404);
	});

	it("GET /zelf-ids/payment-options — returns unique addresses, prices, and a JWT", async () => {
		const response = await request(API_BASE_URL)
			.get(`${ZELF_IDS_PATH}/payment-options`)
			.set("Origin", ORIGIN)
			.set("Authorization", `Bearer ${authToken}`)
			.query({ tagName: reservedName, domain: TEST_DOMAIN, duration: "1" });

		expect(response.status).toBe(200);
		paymentQuote = response.body.data;
		expect(paymentQuote.tagName).toBe(`${reservedName}.${TEST_DOMAIN}`);
		expect(paymentQuote.tagPayName).toBe(`${reservedName}.${TEST_DOMAIN}pay`);
		expect(paymentQuote.duration).toBe(1);
		expect(paymentQuote.paymentAddress).toEqual(
			expect.objectContaining({
				btcAddress: expect.any(String),
				solanaAddress: expect.any(String),
			})
		);
		expect(paymentQuote.prices).toEqual(expect.any(Object));
		expect(typeof paymentQuote.signedDataPrice).toBe("string");

		const decoded = jwt.decode(paymentQuote.signedDataPrice);
		expect(decoded.tagName).toBe(paymentQuote.tagName);
		expect(decoded.tagPayName).toBe(paymentQuote.tagPayName);
		expect(decoded.duration).toBe(1);
	});

	it("POST /zelf-ids/payment-confirmation — 409 without token", async () => {
		const response = await request(API_BASE_URL)
			.post(`${ZELF_IDS_PATH}/payment-confirmation`)
			.set("Origin", ORIGIN)
			.set("Authorization", `Bearer ${authToken}`)
			.send({ tagName: reservedName, domain: TEST_DOMAIN, network: "ETH" });

		expect(response.status).toBe(409);
		expect(response.body).toHaveProperty("validationError");
	});

	it("POST /zelf-ids/payment-confirmation — 401 without auth", async () => {
		const response = await request(API_BASE_URL)
			.post(`${ZELF_IDS_PATH}/payment-confirmation`)
			.set("Origin", ORIGIN)
			.send({
				tagName: reservedName,
				domain: TEST_DOMAIN,
				network: "ETH",
				token: paymentQuote.signedDataPrice,
			});

		expect(response.status).toBe(401);
	});

	it("POST /zelf-ids/payment-confirmation — AVAX is rejected for the unique-address path", async () => {
		const response = await request(API_BASE_URL)
			.post(`${ZELF_IDS_PATH}/payment-confirmation`)
			.set("Origin", ORIGIN)
			.set("Authorization", `Bearer ${authToken}`)
			.send({
				tagName: reservedName,
				domain: TEST_DOMAIN,
				network: "AVAX",
				token: paymentQuote.signedDataPrice,
			});

		expect(response.status).toBe(409);
		expect(`${response.body.code || ""} ${response.body.message || ""}`).toMatch(/avax_use_smart_contract_confirmation/i);
	});

	it("POST /zelf-ids/payment-confirmation — rejects a valid quote used for another name", async () => {
		const response = await request(API_BASE_URL)
			.post(`${ZELF_IDS_PATH}/payment-confirmation`)
			.set("Origin", ORIGIN)
			.set("Authorization", `Bearer ${authToken}`)
			.send({
				tagName: uniqueTagName(),
				domain: TEST_DOMAIN,
				network: "ETH",
				token: paymentQuote.signedDataPrice,
			});

		expect(response.status).toBe(403);
		expect(`${response.body.code || ""} ${response.body.message || ""}`).toMatch(/tag_not_owned/i);
	});

	it("POST /zelf-ids/payment-confirmation — rejects an expired signed quote before provider lookup", async () => {
		expect(process.env.JWT_SECRET).toBeTruthy();
		const expiredToken = jwt.sign(
			{
				...jwt.decode(paymentQuote.signedDataPrice),
				ttl: moment().subtract(1, "minute").unix(),
			},
			process.env.JWT_SECRET
		);

		const response = await request(API_BASE_URL)
			.post(`${ZELF_IDS_PATH}/payment-confirmation`)
			.set("Origin", ORIGIN)
			.set("Authorization", `Bearer ${authToken}`)
			.send({
				tagName: reservedName,
				domain: TEST_DOMAIN,
				network: "ETH",
				token: expiredToken,
			});

		expect(response.status).toBe(409);
		expect(response.body.validationError).toBe("token_expired");
	});

	it("POST /zelf-ids/stripe-checkout — 401 without auth", async () => {
		const response = await request(API_BASE_URL)
			.post(`${ZELF_IDS_PATH}/stripe-checkout`)
			.set("Origin", ORIGIN)
			.send({
				tagName: reservedName,
				domain: TEST_DOMAIN,
				duration: "1",
				plan: "unlimited",
				token: paymentQuote.signedDataPrice,
			});

		expect(response.status).toBe(401);
	});

	it("POST /zelf-ids/stripe-checkout — 409 without token", async () => {
		const response = await request(API_BASE_URL)
			.post(`${ZELF_IDS_PATH}/stripe-checkout`)
			.set("Origin", ORIGIN)
			.set("Authorization", `Bearer ${authToken}`)
			.send({
				tagName: reservedName,
				domain: TEST_DOMAIN,
				duration: "1",
				plan: "unlimited",
			});

		expect(response.status).toBe(409);
		expect(response.body).toHaveProperty("validationError");
	});

	it("GET /zelf-ids/stripe-session — 401 without auth", async () => {
		const response = await request(API_BASE_URL)
			.get(`${ZELF_IDS_PATH}/stripe-session`)
			.set("Origin", ORIGIN)
			.query({ sessionId: "cs_test_missing" });

		expect(response.status).toBe(401);
	});

	it("GET /zelf-ids/stripe-session — 409 without sessionId", async () => {
		const response = await request(API_BASE_URL)
			.get(`${ZELF_IDS_PATH}/stripe-session`)
			.set("Origin", ORIGIN)
			.set("Authorization", `Bearer ${authToken}`);

		expect(response.status).toBe(409);
		expect(response.body).toHaveProperty("validationError");
	});

	it("POST /zelf-ids/payment-confirmation — unpaid unique address stays unconfirmed", async () => {
		const response = await request(API_BASE_URL)
			.post(`${ZELF_IDS_PATH}/payment-confirmation`)
			.set("Origin", ORIGIN)
			.set("Authorization", `Bearer ${authToken}`)
			.send({
				tagName: reservedName,
				domain: TEST_DOMAIN,
				network: "ETH",
				token: paymentQuote.signedDataPrice,
			});

		expect(response.status).toBe(200);
		expect(response.body.data.confirmed).toBe(false);
	});

	it("lease v4migut1* with selfie — free stamp resets from now on premium upgrade", async () => {
		const tagName = `v4migut1${Date.now().toString().slice(-6)}`;
		leasedLongNames.push(tagName);

		const leaseResponse = await request(API_BASE_URL)
			.post(`${ZELF_IDS_PATH}/lease`)
			.set("Origin", ORIGIN)
			.set("Authorization", `Bearer ${authToken}`)
			.send({
				tagName,
				domain: TEST_DOMAIN,
				faceBase64,
				password: TEST_PASSWORD,
				type: "create",
				os: "DESKTOP",
				removePGP: true,
			});

		expect(leaseResponse.status).toBe(200);
		const publicData = leaseResponse.body.data.tagObject.publicData;
		expect(publicData.type).toBe("mainnet");
		expect(publicData.plan).toBe("free");
		expect(Number(publicData.v)).toBe(4);
		expect(moment(publicData.expiresAt).diff(moment(), "year", true)).toBeGreaterThan(50);

		const optionsResponse = await request(API_BASE_URL)
			.get(`${ZELF_IDS_PATH}/payment-options`)
			.set("Origin", ORIGIN)
			.set("Authorization", `Bearer ${authToken}`)
			.query({ tagName, domain: TEST_DOMAIN, duration: "1", plan: "premium" });

		expect(optionsResponse.status).toBe(200);
		expect(optionsResponse.body.data.signedDataPrice).toBeDefined();

		const stamp = resolvePaidExpiresAt({ publicData, duration: "1" });
		expect(moment(stamp).diff(moment(), "year", true)).toBeGreaterThanOrEqual(0.9);
		expect(moment(stamp).diff(moment(), "year", true)).toBeLessThan(2);

		const extra = JSON.parse(
			buildMetadata(
				{ tagName, domain: TEST_DOMAIN, duration: 1, price: 24, plan: "premium" },
				{ publicData },
				{ getTagKey: () => "tagName" }
			).metadata.extraParams
		);
		expect(extra.plan).toBe("premium");
		expect(extra.duration).toBe("1");
		expect(moment(extra.expiresAt).diff(moment(), "year", true)).toBeLessThan(2);
	});

	it("lease v4migut2* overlay — v3.6 paid evidence adds onto stored expiry", async () => {
		const tagName = `v4migut2${Date.now().toString().slice(-6)}`;
		leasedLongNames.push(tagName);

		const leaseResponse = await request(API_BASE_URL)
			.post(`${ZELF_IDS_PATH}/lease`)
			.set("Origin", ORIGIN)
			.set("Authorization", `Bearer ${authToken}`)
			.send({
				tagName,
				domain: TEST_DOMAIN,
				faceBase64,
				password: TEST_PASSWORD,
				type: "create",
				os: "DESKTOP",
				removePGP: true,
			});

		expect(leaseResponse.status).toBe(200);
		const stored = moment().add(8, "month").format("YYYY-MM-DD HH:mm:ss");
		const publicData = {
			...leaseResponse.body.data.tagObject.publicData,
			plan: undefined,
			duration: "1",
			price: 24,
			renewedAt: "2026-03-01 12:00:00",
			expiresAt: stored,
		};
		delete publicData.plan;

		const stamp = resolvePaidExpiresAt({ publicData, duration: "1" });
		expect(moment(stamp).diff(moment(stored, "YYYY-MM-DD HH:mm:ss"), "year", true)).toBeGreaterThanOrEqual(0.9);

		const extra = JSON.parse(
			buildMetadata(
				{ tagName, domain: TEST_DOMAIN, duration: 1, price: 24, plan: "premium" },
				{ publicData },
				{ getTagKey: () => "tagName" }
			).metadata.extraParams
		);
		expect(extra.duration).toBe("2");
		expect(moment(extra.expiresAt).diff(moment(stored, "YYYY-MM-DD HH:mm:ss"), "year", true)).toBeGreaterThanOrEqual(0.9);
	});
});
