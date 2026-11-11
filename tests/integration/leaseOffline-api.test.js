// Lease Offline API Integration Tests - Testing Real Running Server
// This test works with the actual running server
const request = require("supertest");
require("dotenv").config();

// Test against the actual running server
const API_BASE_URL = `http://localhost:${process.env.PORT || 3000}`;

// Sample ZelfProof data for testing
const sampleFaceFromJSON = require("../../config/0012589021.json");
const sampleData = require("../helpers/sampleZelfProof.json");
const sampleTagName = "testcarlos34";
const sampleDomain = "zelf";
const sampleZelfProof = sampleData.zelfProof;
const sampleZelfProofQRCode = sampleData.qr;

describe("Lease Offline API Integration Tests - Real Server", () => {
	let authToken;

	// Create a session and get JWT token before running tests
	beforeAll(async () => {
		const sessionData = {
			identifier: `lease_offline_test_session_${Date.now()}_${Math.random().toString(36).substring(7)}`,
		};

		const sessionResponse = await request(API_BASE_URL).post("/api/sessions").set("Origin", "https://test.example.com").send(sessionData);

		expect(sessionResponse.status).toBe(200);
		authToken = sessionResponse.body.data.token;
		expect(authToken).toBeDefined();
	});

	describe("POST /api/tags/lease-offline - Lease Tag Offline", () => {
		it("should successfully lease a tag offline and then delete from IPFS", async () => {
			// Use the same tagName that's in the sample ZelfProof
			const leaseData = {
				tagName: sampleTagName,
				domain: sampleDomain,
				zelfProof: sampleZelfProof,
				zelfProofQRCode: sampleZelfProofQRCode,
				removePGP: true,
			};

			const response = await request(API_BASE_URL)
				.post("/api/tags/lease-offline")
				.set("Origin", "https://test.example.com")
				.set("Authorization", `Bearer ${authToken}`)
				.send(leaseData);

			expect(response.body).toHaveProperty("data");
			expect(response.body.data.zelfName).toBe(`${sampleTagName}.${sampleDomain}`);

			// wait for 7 seconds
			await new Promise((resolve) => setTimeout(resolve, 3500));

			if (response.status === 200 && response.body.data && response.body.data.ipfs && response.body.data.ipfs.cid) {
				// Test the delete endpoint with the actual CID from the lease response
				const deleteData = {
					tagName: sampleTagName,
					domain: sampleDomain,
					faceBase64: sampleFaceFromJSON.faceBase64,
					password: "testpassword123",
				};

				const deleteResponse = await request(API_BASE_URL)
					.delete("/api/tags/delete")
					.set("Origin", "https://test.example.com")
					.set("Authorization", `Bearer ${authToken}`)
					.send(deleteData);

				expect(deleteResponse.status).toBe(200);
				expect(deleteResponse.body).toHaveProperty("data");
				expect(deleteResponse.body.data).toHaveProperty("deletedFiles");
				expect(deleteResponse.body.data).toHaveProperty("tagObject");
			}
		});

		it("should return error for invalid ZelfProof data", async () => {
			const leaseData = {
				tagName: `offlinetest${Date.now()}`,
				domain: "zelf",
				zelfProofQRCode: "data:image/png;base64,invalid_data",
				removePGP: true,
			};

			const response = await request(API_BASE_URL)
				.post("/api/tags/lease-offline")
				.set("Origin", "https://test.example.com")
				.set("Authorization", `Bearer ${authToken}`)
				.send(leaseData);

			expect(response.status).toBe(500);
			expect(response.body).toHaveProperty("error");
			expect(response.body.error).toContain("INVALID REQUEST");
		});

		it("should return validation error when tagName is missing", async () => {
			const leaseData = {
				// tagName is intentionally missing
				domain: "zelf",
				zelfProof: sampleZelfProof,
				zelfProofQRCode: sampleZelfProofQRCode,
				removePGP: true,
			};

			const response = await request(API_BASE_URL)
				.post("/api/tags/lease-offline")
				.set("Origin", "https://test.example.com")
				.set("Authorization", `Bearer ${authToken}`)
				.send(leaseData);

			expect(response.status).toBe(409);
			expect(response.body).toHaveProperty("validationError");
			expect(response.body.validationError).toContain("tagName");
		});

		it("should return validation error when domain is missing", async () => {
			const leaseData = {
				tagName: `offlinetest${Date.now()}`,
				// domain is intentionally missing
				zelfProof: sampleZelfProof,
				zelfProofQRCode: sampleZelfProofQRCode,
			};

			const response = await request(API_BASE_URL)
				.post("/api/tags/lease-offline")
				.set("Origin", "https://test.example.com")
				.set("Authorization", `Bearer ${authToken}`)
				.send(leaseData);

			expect(response.status).toBe(409);
			expect(response.body).toHaveProperty("validationError");
			expect(response.body.validationError).toContain("domain");
		});

		it("should return validation error when zelfProofQRCode is missing", async () => {
			const leaseData = {
				tagName: `offlinetest${Date.now()}`,
				domain: "zelf",
				zelfProof: sampleZelfProof,
				// zelfProofQRCode is intentionally missing
			};

			const response = await request(API_BASE_URL)
				.post("/api/tags/lease-offline")
				.set("Origin", "https://test.example.com")
				.set("Authorization", `Bearer ${authToken}`)
				.send(leaseData);

			expect(response.status).toBe(409);
			expect(response.body).toHaveProperty("validationError");
			expect(response.body.validationError).toContain("zelfProofQRCode");
		});

		it("should return unauthorized error when JWT token is missing", async () => {
			const leaseData = {
				tagName: `offlinetest${Date.now()}`,
				domain: "zelf",
				zelfProof: sampleZelfProof,
				zelfProofQRCode: sampleZelfProofQRCode,
			};

			const response = await request(API_BASE_URL)
				.post("/api/tags/lease-offline")
				.set("Origin", "https://test.example.com")
				// Authorization header is intentionally missing
				.send(leaseData);

			expect(response.status).toBe(401);
			expect(response.body).toHaveProperty("error");
		});

		it("should handle different domains with invalid data", async () => {
			const domains = ["zelf", "avax"];

			for (const domain of domains) {
				const leaseData = {
					tagName: `test${domain}${Date.now().toString().slice(-6)}`,
					domain: domain,
					zelfProofQRCode: "data:image/png;base64,invalid_data",
				};

				const response = await request(API_BASE_URL)
					.post("/api/tags/lease-offline")
					.set("Origin", "https://test.example.com")
					.set("Authorization", `Bearer ${authToken}`)
					.send(leaseData);

				// Should return either 409 (validation/tag exists/domain not offered) or 500 (ZelfProof error)
				expect([409, 500]).toContain(response.status);
				expect(response.body.error || response.body.validationError || response.body.code).toBeDefined();
			}
		});

		it("should handle sync functionality with invalid data", async () => {
			const leaseData = {
				tagName: `synctest${Date.now()}`,
				domain: "zelf",
				zelfProofQRCode: "data:image/png;base64,invalid_data",
				sync: true,
				syncPassword: "testpassword",
				syncPublicData: {
					ethAddress: "0x1234567890123456789012345678901234567890",
					btcAddress: "bc1qtest123456789012345678901234567890",
					solanaAddress: "Test1234567890123456789012345678901234567890",
					suiAddress: "0xtest1234567890123456789012345678901234567890",
				},
			};

			const response = await request(API_BASE_URL)
				.post("/api/tags/lease-offline")
				.set("Origin", "https://test.example.com")
				.set("Authorization", `Bearer ${authToken}`)
				.send(leaseData);

			expect(response.status).toBe(500);
			expect(response.body).toHaveProperty("error");
		});
	});
});
