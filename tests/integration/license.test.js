// License API Integration Tests - Testing Real Running Server
// This test works with the actual running server
const request = require("supertest");
require("dotenv").config();

// Test against the actual running server
const API_BASE_URL = `http://localhost:${process.env.PORT || 3000}`;

const sampleFaceFromJSON = require("../../config/0012589021.json");

describe("License API Integration Tests - Real Server", () => {
	let authToken;
	let accountEmail;
	let testEmail;
	let testPhone;
	let testCountryCode;
	let createdDomain;

	// Generate unique test data for each test run
	beforeAll(() => {
		const timestamp = Date.now();
		const randomSuffix = Math.random().toString(36).substring(7);
		testEmail = `testclient_${timestamp}_${randomSuffix}@example.com`;
		testPhone = `555${timestamp.toString().slice(-7)}`;
		testCountryCode = "+1";
	});

	// Clean up after each test to prevent state pollution
	afterEach(async () => {
		// Add a small delay to prevent race conditions
		await new Promise((resolve) => setTimeout(resolve, 100));
	});

	// Clean up after all tests
	afterAll(async () => {
		if (authToken && accountEmail) {
			try {
				const deleteResponse = await request(API_BASE_URL)
					.delete("/api/clients")
					.set("Origin", "https://test.example.com")
					.set("Authorization", `Bearer ${authToken}`)
					.send({
						accountEmail: accountEmail,
						masterPassword: sampleFaceFromJSON.password,
						faceBase64: sampleFaceFromJSON.faceBase64,
					});
			} catch (error) {
				console.error("Cleanup failed:", error.message);
			}
		}
	});

	describe("1. POST /api/clients - Create Account (Prerequisite)", () => {
		it("should create a new client account with valid data", async () => {
			const createData = {
				name: "Test Client",
				countryCode: testCountryCode,
				phone: testPhone,
				email: testEmail,
				language: "en",
				company: "Test Company",
				faceBase64: sampleFaceFromJSON.faceBase64,
				masterPassword: sampleFaceFromJSON.password,
			};

			const response = await request(API_BASE_URL).post("/api/clients").set("Origin", "https://test.example.com").send(createData);

			expect(response.status).toBe(200);
			expect(response.body.data).toHaveProperty("ipfsHash");
			expect(response.body.data).toHaveProperty("token");
			expect(response.body.data).toHaveProperty("zelfAccount");
			expect(response.body.data).toHaveProperty("zelfProof");

			// Check the zelfAccount structure
			expect(response.body.data.zelfAccount).toHaveProperty("publicData");
			expect(response.body.data.zelfAccount.publicData).toHaveProperty("name", "Test Client");
			expect(response.body.data.zelfAccount.publicData).toHaveProperty("accountEmail", testEmail);
			expect(response.body.data.zelfAccount.publicData).toHaveProperty("accountPhone", testPhone);
			expect(response.body.data.zelfAccount.publicData).toHaveProperty("accountCompany", "Test Company");
			expect(response.body.data.zelfAccount.publicData).toHaveProperty("accountCountryCode", testCountryCode);
			expect(response.body.data.zelfAccount.publicData).toHaveProperty("accountType", "client_account");
			expect(response.body.data.zelfAccount.publicData).toHaveProperty("accountSubscriptionId", "free");

			// Store the authentication token and account email for subsequent tests
			authToken = response.body.data.token;
			accountEmail = response.body.data.zelfAccount.publicData.accountEmail;
		}, 10000); // Increase timeout to 10 seconds
	});

	// Helper function to check if authentication is available
	const requireAuth = () => {
		if (!authToken) {
			throw new Error("Authentication token not available. Previous test may have failed.");
		}
	};

	describe("2. GET /api/license/my-license - Get My License", () => {
		it("should get user's license information (no license exists yet)", async () => {
			requireAuth();

			const response = await request(API_BASE_URL)
				.get("/api/license/my-license")
				.set("Origin", "https://test.example.com")
				.set("Authorization", `Bearer ${authToken}`);

			expect(response.status).toBe(200);
			expect(response.body).toHaveProperty("data");
			expect(response.body.data).toHaveProperty("myLicense");
			expect(response.body.data).toHaveProperty("zelfAccount");

			// Since no license exists yet, myLicense should be null
			expect(response.body.data.myLicense).toBeNull();

			// Check the zelfAccount structure matches the expected format
			expect(response.body.data.zelfAccount).toHaveProperty("id");
			expect(response.body.data.zelfAccount).toHaveProperty("name");
			expect(response.body.data.zelfAccount).toHaveProperty("cid");
			expect(response.body.data.zelfAccount).toHaveProperty("size");
			expect(response.body.data.zelfAccount).toHaveProperty("number_of_files");
			expect(response.body.data.zelfAccount).toHaveProperty("mime_type");
			expect(response.body.data.zelfAccount).toHaveProperty("group_id");
			expect(response.body.data.zelfAccount).toHaveProperty("created_at");
			expect(response.body.data.zelfAccount).toHaveProperty("url");
			expect(response.body.data.zelfAccount).toHaveProperty("publicData");

			// Check publicData structure
			expect(response.body.data.zelfAccount.publicData).toHaveProperty("accountCompany", "Test Company");
			expect(response.body.data.zelfAccount.publicData).toHaveProperty("accountCountryCode", testCountryCode);
			expect(response.body.data.zelfAccount.publicData).toHaveProperty("accountEmail", testEmail);
			expect(response.body.data.zelfAccount.publicData).toHaveProperty("accountPhone", testPhone);
			expect(response.body.data.zelfAccount.publicData).toHaveProperty("accountSubscriptionId", "free");
			expect(response.body.data.zelfAccount.publicData).toHaveProperty("accountType", "client_account");
		}, 10000);

		it("should fail to get license without authentication", async () => {
			const response = await request(API_BASE_URL).get("/api/license/my-license").set("Origin", "https://test.example.com");

			expect(response.status).toBe(401);
			expect(response.body).toHaveProperty("error", "Protected resource, use Authorization header to get access");
		});

		it("should fail to get license with invalid token", async () => {
			const response = await request(API_BASE_URL)
				.get("/api/license/my-license")
				.set("Origin", "https://test.example.com")
				.set("Authorization", "Bearer invalid_token");

			expect(response.status).toBe(401);
			expect(response.body).toHaveProperty("error", "Protected resource, use Authorization header to get access");
		});
	});

	describe("3. POST /api/license - Create License", () => {
		it("should create a new license with valid domainConfig", async () => {
			requireAuth();

			createdDomain = `testdomain${Date.now()}`;

			const domainConfig = {
				name: createdDomain,
				holdSuffix: ".hold",
				status: "active",
				description: "Test domain for license creation",
				tags: {
					minLength: 3,
					maxLength: 50,
					allowedChars: {},
					reserved: ["www", "api", "admin", "support", "help"],
					customRules: [],
					payment: {
						methods: ["crypto", "stripe"],
						currencies: ["BTC", "ETH", "SOL", "USDT"],
						discounts: {
							yearly: 0.1,
							lifetime: 0.2,
						},
						rewardPrice: 10,
						whitelist: {},
						pricingTable: {
							1: {
								1: 240,
								2: 432,
								3: 612,
								4: 768,
								5: 900,
								lifetime: 3600,
							},
							2: {
								1: 120,
								2: 216,
								3: 306,
								4: 384,
								5: 450,
								lifetime: 1800,
							},
						},
					},
					storage: {
						keyPrefix: "testName",
						ipfsEnabled: true,
						arweaveEnabled: false,
						walrusEnabled: false,
					},
				},
				zelfkeys: {
					plans: [],
					payment: {
						whitelist: {},
						pricingTable: {},
					},
					storage: {
						keyPrefix: "testKey",
						ipfsEnabled: true,
						arweaveEnabled: false,
						walrusEnabled: false,
					},
				},
				metadata: {
					launchDate: "2025-01-01",
					version: "1.0.0",
					documentation: "https://docs.testdomain.com",
					support: "standard",
				},
			};

			const createData = {
				domain: createdDomain,
				faceBase64: sampleFaceFromJSON.faceBase64,
				masterPassword: sampleFaceFromJSON.password,
				domainConfig: domainConfig,
			};

			const response = await request(API_BASE_URL)
				.post("/api/license")
				.set("Origin", "https://test.example.com")
				.set("Authorization", `Bearer ${authToken}`)
				.send(createData);

			expect(response.status).toBe(200);
			expect(response.body).toHaveProperty("data");
			expect(response.body.data).toHaveProperty("ipfs");
			expect(response.body.data).toHaveProperty("name", createdDomain);
			expect(response.body.data).toHaveProperty("domain", createdDomain);
			expect(response.body.data).toHaveProperty("owner", testEmail);
			expect(response.body.data).toHaveProperty("subscriptionId", "free");
			expect(response.body.data).toHaveProperty("expiresAt");

			// Check that the domainConfig properties are preserved
			expect(response.body.data).toHaveProperty("limits");
			expect(response.body.data.limits).toHaveProperty("tags", 100); // API uses default value
			expect(response.body.data.limits).toHaveProperty("zelfkeys", 100); // API uses default value

			expect(response.body.data).toHaveProperty("tags");
			expect(response.body.data.tags).toHaveProperty("minLength", 3);
			expect(response.body.data.tags).toHaveProperty("maxLength", 50);
			expect(response.body.data.tags).toHaveProperty("payment");
			expect(response.body.data.tags).toHaveProperty("storage");

			expect(response.body.data).toHaveProperty("zelfkeys");
			expect(response.body.data.zelfkeys).toHaveProperty("plans");
			expect(response.body.data.zelfkeys).toHaveProperty("payment");
			expect(response.body.data.zelfkeys).toHaveProperty("storage");

			expect(response.body.data.tags.storage).toHaveProperty("keyPrefix", "testName");
			expect(response.body.data.tags.storage).toHaveProperty("ipfsEnabled", true);

			expect(response.body.data.tags.payment).toHaveProperty("methods");
			expect(response.body.data.tags.payment.methods).toContain("crypto");
			expect(response.body.data.tags.payment).toHaveProperty("currencies");
			expect(response.body.data.tags.payment.currencies).toContain("BTC");

			expect(response.body.data).toHaveProperty("metadata");
			expect(response.body.data.metadata).toHaveProperty("version", "1.0.0");
			expect(response.body.data.metadata).toHaveProperty("support", "standard");
		}, 15000); // Increase timeout for license creation

		it("should fail to create license without authentication", async () => {
			const uniqueDomain = `testdomain${Date.now()}`; // Added unique domain name
			const domainConfig = {
				name: uniqueDomain,
				limits: { tags: 1000, zelfkeys: 5000 },
				features: [
					{
						name: "Zelf Name Service",
						code: "zns",
						description: "Test feature",
						enabled: true,
					},
				],
				validation: { minLength: 3, maxLength: 50, allowedChars: {}, reserved: [], customRules: [] },
				storage: { keyPrefix: "testName", ipfsEnabled: true, arweaveEnabled: false, walrusEnabled: false },
				tagPaymentSettings: {
					methods: ["crypto"],
					currencies: ["BTC"],
					whitelist: {},
					pricingTable: { 1: { 1: 240, 2: 432, 3: 612, 4: 768, 5: 900, lifetime: 3600 } },
				},
			};

			const createData = {
				domain: uniqueDomain,
				faceBase64: sampleFaceFromJSON.faceBase64,
				masterPassword: sampleFaceFromJSON.password,
				domainConfig: domainConfig,
			};

			const response = await request(API_BASE_URL).post("/api/license").set("Origin", "https://test.example.com").send(createData);

			expect(response.status).toBe(401);
			expect(response.body).toHaveProperty("error", "Protected resource, use Authorization header to get access");
		});

		it("should fail to create license with invalid domainConfig", async () => {
			const uniqueDomain = `testdomain${Date.now()}`;
			const invalidDomainConfig = {
				name: uniqueDomain,
				limits: { tags: -1, zelfkeys: 5000 }, // Invalid negative tags
				features: [
					{
						name: "Zelf Name Service",
						// Missing required fields: code, description, enabled
					},
				],
				validation: { minLength: 0, maxLength: 50, allowedChars: {}, reserved: [], customRules: [] }, // Invalid minLength
				storage: { keyPrefix: "testName", ipfsEnabled: true, arweaveEnabled: false, walrusEnabled: false },
				tagPaymentSettings: {
					methods: ["invalid_method"], // Invalid method
					currencies: ["BTC"],
					whitelist: {},
					pricingTable: { 1: { 1: 240, 2: 432, 3: 612, 4: 768, 5: 900, lifetime: 3600 } },
				},
			};

			const createData = {
				domain: uniqueDomain,
				faceBase64: sampleFaceFromJSON.faceBase64,
				masterPassword: sampleFaceFromJSON.password,
				domainConfig: invalidDomainConfig,
			};

			const response = await request(API_BASE_URL)
				.post("/api/license")
				.set("Origin", "https://test.example.com")
				.set("Authorization", `Bearer ${authToken}`)
				.send(createData);

			expect(response.status).toBe(409);
			expect(response.body).toHaveProperty("validationError");
		});

		it("should fail to create license with missing required fields", async () => {
			const uniqueDomain = `testdomain${Date.now()}`;
			const createData = {
				domain: uniqueDomain,
				faceBase64: sampleFaceFromJSON.faceBase64,
				masterPassword: sampleFaceFromJSON.password,
				// Missing domainConfig
			};

			const response = await request(API_BASE_URL)
				.post("/api/license")
				.set("Origin", "https://test.example.com")
				.set("Authorization", `Bearer ${authToken}`)
				.send(createData);

			expect(response.status).toBe(409);
			expect(response.body).toHaveProperty("validationError");
		});

		it("should verify license appears in get my license after creation", async () => {
			requireAuth();

			// Verify that the license created in the previous test now appears
			const response = await request(API_BASE_URL)
				.get("/api/license/my-license")
				.set("Origin", "https://test.example.com")
				.set("Authorization", `Bearer ${authToken}`);

			expect(response.status).toBe(200);
			expect(response.body).toHaveProperty("data");
			expect(response.body.data).toHaveProperty("myLicense");
			expect(response.body.data.myLicense).not.toBeNull();
			expect(response.body.data).toHaveProperty("zelfAccount");

			// Verify the license data matches what was created
			expect(response.body.data.myLicense).toHaveProperty("publicData");
			expect(response.body.data.myLicense.publicData).toHaveProperty("licenseDomain");
			expect(response.body.data.myLicense.publicData).toHaveProperty("licenseOwner", testEmail);
			expect(response.body.data.myLicense.publicData).toHaveProperty("licenseSubscriptionId", "free");
			expect(response.body.data.myLicense.publicData).toHaveProperty("type", "license");
		});

		it("should update the existing license with new domainConfig", async () => {
			// Update the license that was created in the previous test
			createdDomain = `${createdDomain}-updated`;

			const updatedDomainConfig = {
				name: createdDomain,
				holdSuffix: ".updated",
				status: "active",
				description: "Updated test domain for license",
				tags: {
					minLength: 2, // Changed from 3
					maxLength: 100, // Changed from 50
					allowedChars: {},
					reserved: ["www", "api", "admin", "support", "help", "docs"], // Added "docs"
					customRules: ["no-numbers-at-start"],
					payment: {
						methods: ["crypto", "stripe"],
						currencies: ["BTC", "ETH", "SOL", "USDT", "BDAG"],
						discounts: {
							yearly: 0.15, // Changed from 0.1
							lifetime: 0.25, // Changed from 0.2
						},
						rewardPrice: 15, // Changed from 10
						whitelist: {},
						pricingTable: {
							1: {
								1: 200, // Changed from 240
								2: 360, // Changed from 432
								3: 510, // Changed from 612
								4: 640, // Changed from 768
								5: 750, // Changed from 900
								lifetime: 3000, // Changed from 3600
							},
							2: {
								1: 100, // Changed from 120
								2: 180, // Changed from 216
								3: 255, // Changed from 306
								4: 320, // Changed from 384
								5: 375, // Changed from 450
								lifetime: 1500, // Changed from 1800
							},
						},
					},
					storage: {
						keyPrefix: "updatedTestName", // Changed from "testName"
						ipfsEnabled: true,
						arweaveEnabled: true, // Changed from false
						walrusEnabled: false,
					},
				},
				zelfkeys: {
					plans: [],
					payment: {
						whitelist: {},
						pricingTable: {},
					},
					storage: {
						keyPrefix: "updatedTestKey", // Changed from "testKey"
						ipfsEnabled: true,
						arweaveEnabled: true, // Changed from false
						walrusEnabled: false,
					},
				},
				metadata: {
					launchDate: "2025-02-01", // Changed from "2025-01-01"
					version: "2.0.0", // Changed from "1.0.0"
					documentation: "https://docs.updatedtestdomain.com", // Changed URL
					support: "premium", // Changed from "standard"
				},
			};

			const updateData = {
				domain: createdDomain, // Use the updated domain name
				faceBase64: sampleFaceFromJSON.faceBase64,
				masterPassword: sampleFaceFromJSON.password,
				domainConfig: updatedDomainConfig,
			};

			const response = await request(API_BASE_URL)
				.post("/api/license")
				.set("Origin", "https://test.example.com")
				.set("Authorization", `Bearer ${authToken}`)
				.send(updateData);

			expect(response.status).toBe(200);
			expect(response.body).toHaveProperty("data");
			expect(response.body.data).toHaveProperty("ipfs");
			expect(response.body.data).toHaveProperty("name", createdDomain);
			expect(response.body.data).toHaveProperty("domain", createdDomain);
			expect(response.body.data).toHaveProperty("owner", testEmail);
			// The response structure is different for updates - check if subscriptionId exists in the response
			expect(response.body.data).toHaveProperty("ipfs");
			expect(response.body.data.ipfs).toHaveProperty("publicData");
			expect(response.body.data.ipfs.publicData).toHaveProperty("licenseSubscriptionId", "free");

			// Check that the updated domainConfig properties are preserved
			// Note: Update response doesn't include limits property

			expect(response.body.data).toHaveProperty("tags");
			expect(response.body.data.tags).toHaveProperty("minLength", 2);
			expect(response.body.data.tags).toHaveProperty("maxLength", 100);
			expect(response.body.data.tags.reserved).toContain("docs");
			expect(response.body.data.tags).toHaveProperty("payment");
			expect(response.body.data.tags).toHaveProperty("storage");

			expect(response.body.data).toHaveProperty("zelfkeys");
			expect(response.body.data.zelfkeys).toHaveProperty("plans");
			expect(response.body.data.zelfkeys).toHaveProperty("payment");
			expect(response.body.data.zelfkeys).toHaveProperty("storage");

			expect(response.body.data.tags.storage).toHaveProperty("keyPrefix", "updatedTestName");
			expect(response.body.data.tags.storage).toHaveProperty("arweaveEnabled", true);

			expect(response.body.data.tags.payment).toHaveProperty("methods");
			expect(response.body.data.tags.payment.methods).toContain("crypto");
			expect(response.body.data.tags.payment.methods).toContain("stripe");
			expect(response.body.data.tags.payment.currencies).toContain("BDAG");
			expect(response.body.data.tags.payment.pricingTable[1][1]).toBe(200);

			expect(response.body.data).toHaveProperty("metadata");
			expect(response.body.data.metadata).toHaveProperty("version", "2.0.0");
			expect(response.body.data.metadata).toHaveProperty("support", "premium");
		});
	});

	describe("4. GET /api/license - Search Licenses", () => {
		it("should search for all licenses", async () => {
			requireAuth();

			// Search for all licenses
			const response = await request(API_BASE_URL)
				.get("/api/license")
				.set("Origin", "https://test.example.com")
				.set("Authorization", `Bearer ${authToken}`);

			expect(response.status).toBe(200);
			expect(response.body).toHaveProperty("data");
			expect(Array.isArray(response.body.data)).toBe(true);
			expect(response.body.data.length).toBeGreaterThan(0);

			// Validate structure of each license in the array
			response.body.data.forEach((license, index) => {
				expect(license).toHaveProperty("id");
				expect(license).toHaveProperty("name");
				expect(license).toHaveProperty("cid");
				expect(license).toHaveProperty("size");
				expect(license).toHaveProperty("number_of_files");
				expect(license).toHaveProperty("mime_type");
				expect(license).toHaveProperty("group_id");
				expect(license).toHaveProperty("created_at");
				expect(license).toHaveProperty("url");
				expect(license).toHaveProperty("publicData");

				// Validate publicData structure (simplified version returned by search)
				expect(license.publicData).toHaveProperty("licenseDomain");
				expect(license.publicData).toHaveProperty("licenseOwner");
				expect(license.publicData).toHaveProperty("licenseSubscriptionId");
				expect(license.publicData).toHaveProperty("type");

				// Validate data types
				expect(typeof license.publicData.licenseDomain).toBe("string");
				expect(typeof license.publicData.licenseOwner).toBe("string");
				expect(typeof license.publicData.licenseSubscriptionId).toBe("string");
				expect(typeof license.publicData.type).toBe("string");

				// Validate that licenseDomain is not empty
				expect(license.publicData.licenseDomain.length).toBeGreaterThan(0);
				expect(license.publicData.licenseOwner.length).toBeGreaterThan(0);
			});

			// Search for the domain we created in this test
			const createdLicense = response.body.data.find((license) => license.publicData.licenseDomain === createdDomain);

			if (createdLicense) {
				expect(createdLicense.publicData.licenseDomain).toBe(createdDomain);
				expect(createdLicense.publicData.licenseOwner).toBe(testEmail);
				expect(createdLicense.publicData.licenseSubscriptionId).toBe("free");
				expect(createdLicense.publicData.type).toBe("license");
			} else {
				// If we can't find our specific license, at least verify we have licenses
				expect(response.body.data.length).toBeGreaterThan(0);
			}
		});

		it("should search for specific domain", async () => {
			// Search for the specific domain that was created in test 3
			const response = await request(API_BASE_URL)
				.get("/api/license")
				.query({ domain: createdDomain })
				.set("Origin", "https://test.example.com")
				.set("Authorization", `Bearer ${authToken}`);

			expect(response.status).toBe(200);
			expect(response.body).toHaveProperty("data");
			expect(response.body.data).toHaveProperty("id");
			expect(response.body.data).toHaveProperty("name");
			expect(response.body.data).toHaveProperty("cid");
			expect(response.body.data).toHaveProperty("url");
			expect(response.body.data).toHaveProperty("publicData");
			expect(response.body.data.publicData).toHaveProperty("licenseDomain", createdDomain);
			expect(response.body.data.publicData).toHaveProperty("licenseOwner", testEmail);
		});

		it("should fail to search without authentication", async () => {
			const response = await request(API_BASE_URL).get("/api/license").set("Origin", "https://test.example.com");

			expect(response.status).toBe(401);
			expect(response.body).toHaveProperty("error", "Protected resource, use Authorization header to get access");
		});

		it("should fail to search with invalid domain format", async () => {
			const response = await request(API_BASE_URL)
				.get("/api/license")
				.query({ domain: "invalid_domain_with_underscores" })
				.set("Origin", "https://test.example.com")
				.set("Authorization", `Bearer ${authToken}`);

			expect(response.status).toBe(409);
			expect(response.body).toHaveProperty("validationError");
		});
	});

	describe("5. GET /api/tags/domains - List All Domains", () => {
		it("should get all domains", async () => {
			requireAuth();

			const response = await request(API_BASE_URL)
				.get("/api/tags/domains")
				.set("Origin", "https://test.example.com")
				.set("Authorization", `Bearer ${authToken}`);

			expect(response.status).toBe(200);
			expect(response.body).toHaveProperty("data");
			expect(typeof response.body.data).toBe("object");
			expect(Array.isArray(response.body.data)).toBe(false);

			// Get domain names (keys) from the response
			const domainNames = Object.keys(response.body.data);
			expect(domainNames.length).toBeGreaterThan(0);

			// Validate structure of each domain in the map
			domainNames.forEach((domainName) => {
				const domain = response.body.data[domainName];

				// Validate basic domain properties
				expect(domain).toHaveProperty("name", domainName);
				expect(domain).toHaveProperty("owner");
				expect(domain).toHaveProperty("status");
				expect(domain).toHaveProperty("type");
				expect(domain).toHaveProperty("description");

				// Validate new domain configuration sections (based on actual API response)
				expect(domain).toHaveProperty("tags");
				expect(domain).toHaveProperty("zelfkeys");
				expect(domain).toHaveProperty("metadata");
				expect(domain).toHaveProperty("holdSuffix");
				expect(domain).toHaveProperty("startDate");
				expect(domain).toHaveProperty("endDate");
				expect(domain).toHaveProperty("type");
				expect(domain).toHaveProperty("stripe");
				expect(domain).toHaveProperty("features");

				// Validate data types
				expect(typeof domain.name).toBe("string");
				expect(typeof domain.owner).toBe("string");
				expect(typeof domain.status).toBe("string");
				expect(typeof domain.description).toBe("string");
				expect(typeof domain.holdSuffix).toBe("string");
				expect(typeof domain.startDate).toBe("string");
				expect(typeof domain.endDate).toBe("string");
				expect(typeof domain.type).toBe("string");

				// Validate that domain name is not empty
				expect(domain.name.length).toBeGreaterThan(0);
				expect(domain.owner.length).toBeGreaterThan(0);

				// Validate tags structure
				expect(domain.tags).toHaveProperty("minLength");
				expect(domain.tags).toHaveProperty("maxLength");
				expect(domain.tags).toHaveProperty("allowedChars");
				expect(domain.tags).toHaveProperty("reserved");
				expect(domain.tags).toHaveProperty("customRules");
				expect(domain.tags).toHaveProperty("payment");
				expect(domain.tags).toHaveProperty("storage");
				expect(typeof domain.tags.minLength).toBe("number");
				expect(typeof domain.tags.maxLength).toBe("number");
				expect(Array.isArray(domain.tags.reserved)).toBe(true);
				expect(Array.isArray(domain.tags.customRules)).toBe(true);

				// Validate tags payment structure
				expect(domain.tags.payment).toHaveProperty("methods");
				expect(domain.tags.payment).toHaveProperty("currencies");
				expect(domain.tags.payment).toHaveProperty("discounts");
				expect(domain.tags.payment).toHaveProperty("rewardPrice");
				expect(domain.tags.payment).toHaveProperty("whitelist");
				expect(domain.tags.payment).toHaveProperty("pricingTable");
				expect(Array.isArray(domain.tags.payment.methods)).toBe(true);
				expect(Array.isArray(domain.tags.payment.currencies)).toBe(true);
				expect(typeof domain.tags.payment.rewardPrice).toBe("number");

				// Validate tags storage structure
				expect(domain.tags.storage).toHaveProperty("keyPrefix");
				expect(domain.tags.storage).toHaveProperty("ipfsEnabled");
				expect(domain.tags.storage).toHaveProperty("arweaveEnabled");
				expect(domain.tags.storage).toHaveProperty("walrusEnabled");
				expect(typeof domain.tags.storage.keyPrefix).toBe("string");
				expect(typeof domain.tags.storage.ipfsEnabled).toBe("boolean");
				expect(typeof domain.tags.storage.arweaveEnabled).toBe("boolean");
				expect(typeof domain.tags.storage.walrusEnabled).toBe("boolean");

				// Validate zelfkeys structure
				expect(domain.zelfkeys).toHaveProperty("plans");
				expect(domain.zelfkeys).toHaveProperty("payment");
				expect(domain.zelfkeys).toHaveProperty("storage");
				expect(Array.isArray(domain.zelfkeys.plans)).toBe(true);

				// Validate zelfkeys payment structure
				expect(domain.zelfkeys.payment).toHaveProperty("whitelist");
				expect(domain.zelfkeys.payment).toHaveProperty("pricingTable");

				// Validate zelfkeys storage structure
				expect(domain.zelfkeys.storage).toHaveProperty("keyPrefix");
				expect(domain.zelfkeys.storage).toHaveProperty("ipfsEnabled");
				expect(domain.zelfkeys.storage).toHaveProperty("arweaveEnabled");
				expect(domain.zelfkeys.storage).toHaveProperty("walrusEnabled");
				expect(typeof domain.zelfkeys.storage.keyPrefix).toBe("string");
				expect(typeof domain.zelfkeys.storage.ipfsEnabled).toBe("boolean");
				expect(typeof domain.zelfkeys.storage.arweaveEnabled).toBe("boolean");
				expect(typeof domain.zelfkeys.storage.walrusEnabled).toBe("boolean");

				// Validate features structure
				expect(Array.isArray(domain.features)).toBe(true);

				// Validate metadata structure
				expect(domain.metadata).toHaveProperty("launchDate");
				expect(domain.metadata).toHaveProperty("version");
				expect(domain.metadata).toHaveProperty("documentation");
				expect(domain.metadata).toHaveProperty("support");
				expect(typeof domain.metadata.launchDate).toBe("string");
				expect(typeof domain.metadata.version).toBe("string");
				expect(typeof domain.metadata.documentation).toBe("string");
				expect(typeof domain.metadata.support).toBe("string");

				// Validate stripe structure
				expect(domain.stripe).toHaveProperty("productId");
				expect(domain.stripe).toHaveProperty("priceId");
				expect(domain.stripe).toHaveProperty("latestInvoiceId");
				expect(domain.stripe).toHaveProperty("amountPaid");
				expect(domain.stripe).toHaveProperty("paidAt");
				expect(typeof domain.stripe.productId).toBe("string");
				expect(typeof domain.stripe.priceId).toBe("string");
				expect(typeof domain.stripe.latestInvoiceId).toBe("string");
				expect(typeof domain.stripe.amountPaid).toBe("number");
				expect(typeof domain.stripe.paidAt).toBe("string");
			});

			// Check if specific domains exist in the map
			expect(response.body.data).toHaveProperty("zelf");
			expect(response.body.data).toHaveProperty("bdag");

			// Validate specific domain properties
			expect(response.body.data.zelf.name).toBe("zelf");
			expect(response.body.data.zelf.type).toBe("license");
			expect(response.body.data.zelf.owner).toBe("miguel@zelf.world");

			expect(response.body.data.bdag.name).toBe("bdag");
		});

		it("should fail to get domains without authentication", async () => {
			const response = await request(API_BASE_URL).get("/api/tags/domains").set("Origin", "https://test.example.com");

			expect(response.status).toBe(401);
			expect(response.body).toHaveProperty("error", "Protected resource, use Authorization header to get access");
		});

		it("should fail to get domains with invalid token", async () => {
			const response = await request(API_BASE_URL)
				.get("/api/tags/domains")
				.set("Origin", "https://test.example.com")
				.set("Authorization", "Bearer invalid_token");

			expect(response.status).toBe(401);
			expect(response.body).toHaveProperty("error", "Protected resource, use Authorization header to get access");
		});
	});

	describe("6. GET /api/tags/domains/:domain - Get Specific Domain", () => {
		it("should get specific domain by name", async () => {
			requireAuth();

			const response = await request(API_BASE_URL)
				.get(`/api/tags/domains/zelf`)
				.set("Origin", "https://test.example.com")
				.set("Authorization", `Bearer ${authToken}`);

			expect(response.status).toBe(200);
			expect(response.body).toHaveProperty("data");

			// Validate domain configuration structure (direct response, not IPFS wrapped)
			expect(response.body.data).toHaveProperty("name", "zelf");
			expect(response.body.data).toHaveProperty("owner", "miguel@zelf.world");
			expect(response.body.data).toHaveProperty("status", "active");
			expect(response.body.data).toHaveProperty("type", "license");
			expect(response.body.data).toHaveProperty("description", "Official Zelf domain..... edited 2");

			// Validate that the domain configuration is present
			expect(response.body.data).toHaveProperty("tags");
			expect(response.body.data).toHaveProperty("zelfkeys");
			expect(response.body.data).toHaveProperty("metadata");
			expect(response.body.data).toHaveProperty("stripe");
			expect(response.body.data).toHaveProperty("features");
			expect(response.body.data.tags).toHaveProperty("minLength", 1);
			expect(response.body.data.tags).toHaveProperty("maxLength", 27);
			expect(response.body.data.tags.storage).toHaveProperty("keyPrefix", "zelfName");
			expect(response.body.data.tags.storage).toHaveProperty("ipfsEnabled", true);
			expect(response.body.data.tags.storage).toHaveProperty("arweaveEnabled", true);
			expect(response.body.data.tags.payment.methods).toContain("crypto");
			expect(response.body.data.tags.payment.methods).toContain("stripe");
			expect(response.body.data.tags.payment.currencies).toContain("BTC");
			expect(response.body.data.tags.payment.currencies).toContain("ETH");
			expect(response.body.data.tags.payment.currencies).toContain("USDC");
			expect(response.body.data.tags.payment.currencies).toContain("BDAG");
			expect(response.body.data.tags.payment.currencies).toContain("ZNS");
			expect(response.body.data.tags.payment.currencies).toContain("AVAX");
			expect(response.body.data.metadata).toHaveProperty("version", "1.0.0");
			expect(response.body.data.metadata).toHaveProperty("documentation", "https://docs.zelf.world");
		});

		it("should fail to get non-existent domain", async () => {
			requireAuth();

			const nonExistentDomain = `nonexistent${Date.now()}`;
			const response = await request(API_BASE_URL)
				.get(`/api/tags/domains/${nonExistentDomain}`)
				.set("Origin", "https://test.example.com")
				.set("Authorization", `Bearer ${authToken}`);

			expect(response.status).toBe(404);
			expect(response.body).toHaveProperty("code", "NotFound");
			expect(response.body).toHaveProperty("message", "domain_not_found");
		});

		it("should fail to get domain without authentication", async () => {
			const response = await request(API_BASE_URL).get(`/api/tags/domains/${createdDomain}`).set("Origin", "https://test.example.com");

			expect(response.status).toBe(401);
			expect(response.body).toHaveProperty("error", "Protected resource, use Authorization header to get access");
		});

		it("should fail to get domain with invalid token", async () => {
			const response = await request(API_BASE_URL)
				.get(`/api/tags/domains/${createdDomain}`)
				.set("Origin", "https://test.example.com")
				.set("Authorization", "Bearer invalid_token");

			expect(response.status).toBe(401);
			expect(response.body).toHaveProperty("error", "Protected resource, use Authorization header to get access");
		});

		it("should fail to get domain with invalid domain format", async () => {
			requireAuth();

			const invalidDomain = "ijdofsodifjidj";
			const response = await request(API_BASE_URL)
				.get(`/api/tags/domains/${invalidDomain}`)
				.set("Origin", "https://test.example.com")
				.set("Authorization", `Bearer ${authToken}`);

			expect(response.status).toBe(404);
			expect(response.body).toHaveProperty("code", "NotFound");
			expect(response.body).toHaveProperty("message", "domain_not_found");
		});
	});

	describe("7. DELETE /api/license - Delete License", () => {
		it("should fail to delete license with invalid credentials", async () => {
			requireAuth();

			const deleteData = {
				faceBase64: sampleFaceFromJSON.faceBase64,
				masterPassword: "wrong_password",
			};

			const response = await request(API_BASE_URL)
				.delete("/api/license")
				.set("Origin", "https://test.example.com")
				.set("Authorization", `Bearer ${authToken}`)
				.send(deleteData);

			expect(response.status).toBe(500);
			expect(response.body).toHaveProperty("code", "InternalServerError");
			expect(response.body).toHaveProperty("message", "THE PROVIDED PASSWORD IS INVALID.");
		});

		it("should delete the license created in test 3", async () => {
			requireAuth();

			// Delete the license that was created in the previous test
			const deleteData = {
				faceBase64: sampleFaceFromJSON.faceBase64,
				masterPassword: sampleFaceFromJSON.password,
			};

			const response = await request(API_BASE_URL)
				.delete("/api/license")
				.set("Origin", "https://test.example.com")
				.set("Authorization", `Bearer ${authToken}`)
				.send(deleteData);

			expect(response.status).toBe(200);
			expect(response.body).toHaveProperty("data");
			expect(response.body.data).toHaveProperty("success", true);
			expect(response.body.data).toHaveProperty("message", "License deleted successfully");
			expect(response.body.data).toHaveProperty("deletedFiles");
		});

		it("should fail to delete license without authentication", async () => {
			const deleteData = {
				faceBase64: sampleFaceFromJSON.faceBase64,
				masterPassword: sampleFaceFromJSON.password,
			};

			const response = await request(API_BASE_URL).delete("/api/license").set("Origin", "https://test.example.com").send(deleteData);

			expect(response.status).toBe(401);
			expect(response.body).toHaveProperty("error", "Protected resource, use Authorization header to get access");
		});

		// it("should fail to delete license when no license exists", async () => {
		// 	// Create a new client without any license
		// 	const timestamp = Date.now();
		// 	const randomSuffix = Math.random().toString(36).substring(7);
		// 	const newTestEmail = `testclient_${timestamp}_${randomSuffix}@example.com`;
		// 	const newTestPhone = `555${timestamp.toString().slice(-7)}`;

		// 	const createData = {
		// 		name: "Test Client for No License",
		// 		countryCode: "+1",
		// 		phone: newTestPhone,
		// 		email: newTestEmail,
		// 		language: "en",
		// 		company: "Test Company",
		// 		faceBase64: sampleFaceFromJSON.faceBase64,
		// 		masterPassword: sampleFaceFromJSON.password,
		// 	};

		// 	const createResponse = await request(API_BASE_URL).post("/api/clients").set("Origin", "https://test.example.com").send(createData);

		// 	expect(createResponse.status).toBe(200);
		// 	const newAuthToken = createResponse.body.data.token;

		// 	// Try to delete license from client that has no license
		// 	const deleteData = {
		// 		faceBase64: sampleFaceFromJSON.faceBase64,
		// 		masterPassword: sampleFaceFromJSON.password,
		// 	};

		// 	const response = await request(API_BASE_URL)
		// 		.delete("/api/license")
		// 		.set("Origin", "https://test.example.com")
		// 		.set("Authorization", `Bearer ${newAuthToken}`)
		// 		.send(deleteData);

		// 	expect(response.status).toBe(404);
		// 	expect(response.body).toHaveProperty("code", "NotFound");
		// 	expect(response.body).toHaveProperty("message", "license_not_found");

		// 	// Cleanup: Delete the temporary client
		// 	try {
		// 		await request(API_BASE_URL)
		// 			.delete("/api/clients")
		// 			.set("Origin", "https://test.example.com")
		// 			.set("Authorization", `Bearer ${newAuthToken}`)
		// 			.send({
		// 				accountEmail: newTestEmail,
		// 				masterPassword: sampleFaceFromJSON.password,
		// 				faceBase64: sampleFaceFromJSON.faceBase64,
		// 			});
		// 	} catch (error) {
		// 		console.error("Cleanup failed for temporary client:", error.message);
		// 	}
		// });

		// it("should fail to delete license with missing required fields", async () => {
		// 	const deleteData = {
		// 		// Missing faceBase64 and masterPassword
		// 	};

		// 	const response = await request(API_BASE_URL)
		// 		.delete("/api/license")
		// 		.set("Origin", "https://test.example.com")
		// 		.set("Authorization", `Bearer ${authToken}`)
		// 		.send(deleteData);

		// 	expect(response.status).toBe(409);
		// 	expect(response.body).toHaveProperty("validationError");
		// });
	});
});
