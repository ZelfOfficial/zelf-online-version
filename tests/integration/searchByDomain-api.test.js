// Search By Domain API Integration Tests - Testing Real Running Server
// This test works with the actual running server
const request = require("supertest");
require("dotenv").config();

// Test against the actual running server
const API_BASE_URL = `http://localhost:${process.env.PORT || 3000}`;

describe("Search By Domain API Integration Tests - Real Server", () => {
	let authToken;

	// Create a session and get JWT token before running tests
	beforeAll(async () => {
		const sessionData = {
			identifier: `search_domain_test_session_${Date.now()}_${Math.random().toString(36).substring(7)}`,
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

	describe("GET /api/tags/search-by-domain - Search Tags by Domain", () => {
		it("should search for tags in IPFS storage", async () => {
			const searchParams = {
				domain: "zelf",
				storage: "IPFS",
			};

			const response = await request(API_BASE_URL)
				.get("/api/tags/search-by-domain")
				.set("Origin", "https://test.example.com")
				.set("Authorization", `Bearer ${authToken}`)
				.query(searchParams);

			expect(response.status).toBe(200);
			expect(response.body).toHaveProperty("data");
		});

		it("should accept optional name filter for IPFS pin names (suffix / LIKE-style)", async () => {
			const searchParams = {
				domain: "zelf",
				storage: "IPFS",
				name: ".zelfpay",
			};

			const response = await request(API_BASE_URL)
				.get("/api/tags/search-by-domain")
				.set("Origin", "https://test.example.com")
				.set("Authorization", `Bearer ${authToken}`)
				.query(searchParams);

			expect(response.status).toBe(200);
			expect(response.body).toHaveProperty("data");
			expect(Array.isArray(response.body.data)).toBe(true);
		});

		it("should search for tags in Arweave storage", async () => {
			const searchParams = {
				domain: "zelf",
				storage: "Arweave",
			};

			const response = await request(API_BASE_URL)
				.get("/api/tags/search-by-domain")
				.set("Origin", "https://test.example.com")
				.set("Authorization", `Bearer ${authToken}`)
				.query(searchParams);

			expect(response.status).toBe(200);
			expect(response.body).toHaveProperty("data");
		});

		it("should return validation error when domain is missing", async () => {
			const searchParams = {
				// domain is intentionally missing
				storage: "IPFS",
			};

			const response = await request(API_BASE_URL)
				.get("/api/tags/search-by-domain")
				.set("Origin", "https://test.example.com")
				.set("Authorization", `Bearer ${authToken}`)
				.query(searchParams);

			expect(response.status).toBe(409);
			expect(response.body).toHaveProperty("validationError");
			expect(response.body.validationError).toContain("domain");
		});

		it("should return validation error when storage is missing", async () => {
			const searchParams = {
				domain: "zelf",
				// storage is intentionally missing
			};

			const response = await request(API_BASE_URL)
				.get("/api/tags/search-by-domain")
				.set("Origin", "https://test.example.com")
				.set("Authorization", `Bearer ${authToken}`)
				.query(searchParams);

			expect(response.status).toBe(409);
			expect(response.body).toHaveProperty("validationError");
			expect(response.body.validationError).toContain("storage");
		});

		it("should return validation error for invalid storage type", async () => {
			const searchParams = {
				domain: "zelf",
				storage: "InvalidStorage",
			};

			const response = await request(API_BASE_URL)
				.get("/api/tags/search-by-domain")
				.set("Origin", "https://test.example.com")
				.set("Authorization", `Bearer ${authToken}`)
				.query(searchParams);

			expect(response.status).toBe(409);
			expect(response.body).toHaveProperty("validationError");
			expect(response.body.validationError).toContain("storage");
		});

		it("should return unauthorized error when JWT token is missing", async () => {
			const searchParams = {
				domain: "zelf",
				storage: "IPFS",
			};

			const response = await request(API_BASE_URL)
				.get("/api/tags/search-by-domain")
				.set("Origin", "https://test.example.com")
				// Authorization header is intentionally missing
				.query(searchParams);

			expect(response.status).toBe(401);
			expect(response.body).toHaveProperty("error");
		});

		it("should search for tags in different domains", async () => {
			const domains = ["zelf", "avax"];

			for (const domain of domains) {
				const searchParams = {
					domain: domain,
					storage: "IPFS",
				};

				const response = await request(API_BASE_URL)
					.get("/api/tags/search-by-domain")
					.set("Origin", "https://test.example.com")
					.set("Authorization", `Bearer ${authToken}`)
					.query(searchParams);

				expect(response.status).toBe(200);
				expect(response.body).toHaveProperty("data");
			}
		});
	});
});
