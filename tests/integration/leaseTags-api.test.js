// Lease Tags API Integration Tests - Testing Real Running Server
// This test works with the actual running server
const request = require("supertest");
require("dotenv").config();

// Test against the actual running server
const API_BASE_URL = `http://localhost:${process.env.PORT || 3000}`;

const sampleFaceFromJSON = require("../../config/0012589021.json");

describe("Lease Tags API Integration Tests - Real Server", () => {
	let authToken;

	// Create a session and get JWT token before running tests
	beforeAll(async () => {
		const sessionData = {
			identifier: `lease_test_session_${Date.now()}_${Math.random().toString(36).substring(7)}`,
			type: "createWallet",
			isWebExtension: false,
		};

		const sessionResponse = await request(API_BASE_URL)
			.post("/api/sessions")
			.set("Origin", "https://test.example.com")
			.send(sessionData)
			.expect(200);

		authToken = sessionResponse.body.data.token;
		expect(authToken).toBeDefined();
	});

	describe("POST /api/tags/lease - Lease Tag", () => {
		it("should lease a tag with valid data", async () => {
			const leaseData = {
				tagName: `test${Date.now()}`,
				domain: "zelf",
				faceBase64: sampleFaceFromJSON.faceBase64,
				type: "create",
				os: "DESKTOP",
				removePGP: true,
			};

			const response = await request(API_BASE_URL)
				.post("/api/tags/lease")
				.set("Origin", "https://test.example.com")
				.set("Authorization", `Bearer ${authToken}`)
				.send(leaseData);

			expect(response.body).toHaveProperty("data");

			expect(response.body.data).toHaveProperty("ethAddress");
			expect(response.body.data).toHaveProperty("solanaAddress");
			expect(response.body.data).toHaveProperty("btcAddress");
			expect(response.body.data).toHaveProperty("domain");
			expect(response.body.data).toHaveProperty("price");
			expect(response.body.data).toHaveProperty("reward");
			expect(response.body.data).toHaveProperty("discount");
			expect(response.body.data).toHaveProperty("discountType");
			expect(response.body.data).toHaveProperty("suiAddress");
			expect(response.body.data).toHaveProperty("hasPassword");
			expect(response.body.data).toHaveProperty("zelfProof");
			expect(response.body.data).toHaveProperty("zelfProofQRCode");
			expect(response.body.data).toHaveProperty("ipfs");
			const publicData = response.body.data.tagObject?.publicData || response.body.data.ipfs?.[0]?.publicData || {};
			if (publicData && Object.keys(publicData).length) {
				expect(Number(publicData.v)).toBe(3);
			}
		});

		it("should reject a new .avax name", async () => {
			const leaseData = {
				tagName: `test${Date.now()}`,
				domain: "avax",
				faceBase64: sampleFaceFromJSON.faceBase64,
				type: "create",
				os: "DESKTOP",
				removePGP: true,
			};

			const response = await request(API_BASE_URL)
				.post("/api/tags/lease")
				.set("Origin", "https://test.example.com")
				.set("Authorization", `Bearer ${authToken}`)
				.send(leaseData);

			expect(response.status).toBe(409);
			expect(response.body.code).toBe("DOMAIN_NOT_OFFERED");
		});

		it("should return validation error when tagName is missing", async () => {
			const leaseData = {
				// tagName is intentionally missing
				domain: "avax",
				faceBase64: sampleFaceFromJSON.faceBase64,
				type: "create",
				os: "DESKTOP",
				removePGP: true,
			};

			const response = await request(API_BASE_URL)
				.post("/api/tags/lease")
				.set("Origin", "https://test.example.com")
				.set("Authorization", `Bearer ${authToken}`)
				.send(leaseData);

			expect(response.status).toBe(409);
			expect(response.body).toHaveProperty("validationError");
			expect(response.body.validationError).toContain("tagName");
		});

		it("should return unauthorized error when JWT token is missing", async () => {
			const leaseData = {
				tagName: `test${Date.now()}`,
				domain: "avax",
				faceBase64: sampleFaceFromJSON.faceBase64,
				type: "create",
				os: "DESKTOP",
				removePGP: true,
			};

			const response = await request(API_BASE_URL)
				.post("/api/tags/lease")
				.set("Origin", "https://test.example.com")
				// Authorization header is intentionally missing
				.send(leaseData);

			expect(response.status).toBe(401);
			expect(response.body).toHaveProperty("error");
		});
	});
});
