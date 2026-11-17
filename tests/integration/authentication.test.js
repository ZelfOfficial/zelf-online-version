// Client Authentication API Integration Tests - Testing Real Running Server
// This test works with the actual running server
const request = require("supertest");
require("dotenv").config();

// Test against the actual running server
const API_BASE_URL = `http://localhost:${process.env.PORT || 3000}`;

const sampleFaceFromJSON = require("../../config/0012589021.json");

describe("Client Authentication API Integration Tests - Real Server", () => {
    let authToken;
    let accountEmail;
    let testEmail;
    let testPhone;
    let testCountryCode;

    // Generate unique test data
    beforeAll(() => {
        const timestamp = Date.now();
        const randomSuffix = Math.random().toString(36).substring(7);
        testEmail = `testclient_${timestamp}_${randomSuffix}@example.com`;
        testPhone = `555${timestamp.toString().slice(-7)}`;
        testCountryCode = "+1";
    });

    describe("1. POST /api/clients - Create Account", () => {
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
            expect(response.body.data.zelfAccount.publicData).toHaveProperty("accountCountryCode", testCountryCode);
            expect(response.body.data.zelfAccount.publicData).toHaveProperty("accountCompany", "Test Company");
            expect(response.body.data.zelfAccount.publicData).toHaveProperty("accountType", "client_account");

            // Store the created client ID for later tests (using email as identifier)
            accountEmail = response.body.data.zelfAccount.publicData.accountEmail;

            expect(accountEmail).toBeDefined();
        });

        it("should fail to create account with missing required fields", async () => {
            const invalidData = {
                name: "Test Client",
                // Missing required fields: countryCode, phone, email, faceBase64, masterPassword
            };

            const response = await request(API_BASE_URL).post("/api/clients").set("Origin", "https://test.example.com").send(invalidData);

            expect(response.status).toBe(409);
            expect(response.body).toHaveProperty("validationError");
        });

        it("should fail to create account with invalid email format", async () => {
            const invalidData = {
                name: "Test Client",
                countryCode: testCountryCode,
                phone: testPhone,
                email: "invalid-email-format",
                language: "en",
                company: "Test Company",
                faceBase64: sampleFaceFromJSON.faceBase64,
                masterPassword: sampleFaceFromJSON.password,
            };

            const response = await request(API_BASE_URL).post("/api/clients").set("Origin", "https://test.example.com").send(invalidData);

            expect(response.status).toBe(409);
            expect(response.body).toHaveProperty("validationError");
        });
    });

    describe("2. GET /api/clients - Verify Client (Account Available)", () => {
        it("should verify that the created client exists by email", async () => {
            const response = await request(API_BASE_URL).get("/api/clients").query({ email: testEmail });

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty("data");
            expect(response.body.data).toHaveProperty("id");
            expect(response.body.data).toHaveProperty("cid");
            expect(response.body.data).toHaveProperty("url");
            expect(response.body.data).toHaveProperty("publicData");
            expect(response.body.data.publicData).toHaveProperty("accountEmail", testEmail);
            expect(response.body.data.publicData).toHaveProperty("accountPhone", testPhone);
            expect(response.body.data.publicData).toHaveProperty("accountCompany", "Test Company");
            expect(response.body.data.publicData).toHaveProperty("accountCountryCode", testCountryCode);
            expect(response.body.data.publicData).toHaveProperty("accountType", "client_account");
        });

        it("should verify that the created client exists by phone", async () => {
            const response = await request(API_BASE_URL).get("/api/clients").query({
                countryCode: testCountryCode,
                phone: testPhone,
            });

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty("data");
            expect(response.body.data).toHaveProperty("id");
            expect(response.body.data).toHaveProperty("cid");
            expect(response.body.data).toHaveProperty("url");
            expect(response.body.data).toHaveProperty("publicData");
            expect(response.body.data.publicData).toHaveProperty("accountEmail", testEmail);
            expect(response.body.data.publicData).toHaveProperty("accountPhone", testPhone);
            expect(response.body.data.publicData).toHaveProperty("accountCompany", "Test Company");
            expect(response.body.data.publicData).toHaveProperty("accountCountryCode", testCountryCode);
            expect(response.body.data.publicData).toHaveProperty("accountType", "client_account");
        });

        it("should return client not found for non-existent email", async () => {
            const response = await request(API_BASE_URL).get("/api/clients").query({ email: "nonexistent@example.com" });

            expect(response.status).toBe(404);
            expect(response.body).toHaveProperty("code", "NotFound");
            expect(response.body).toHaveProperty("message", "client_not_found");
        });

        it("should reject listing all clients when no parameters are provided", async () => {
            const response = await request(API_BASE_URL).get("/api/clients");

            expect(response.status).toBe(400);
            expect(response.body).toHaveProperty("code", "CLIENT_IDENTIFIER_REQUIRED");
        });
    });

    describe("3. POST /api/clients/auth - Authenticate Client", () => {
        it("should authenticate client with valid credentials and get JWT", async () => {
            const authData = {
                email: testEmail,
                faceBase64: sampleFaceFromJSON.faceBase64,
                masterPassword: sampleFaceFromJSON.password,
                identificationMethod: "email",
            };

            const response = await request(API_BASE_URL).post("/api/clients/auth").set("Origin", "https://test.example.com").send(authData);

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty("data");
            expect(response.body.data).toHaveProperty("token");
            expect(response.body.data).toHaveProperty("zelfProof");
            expect(response.body.data).toHaveProperty("zelfAccount");

            // Store the JWT token for later tests
            authToken = response.body.data.token;

            expect(authToken).toBeDefined();
        });
    });

    it("should authenticate client with phone credentials", async () => {
        const authData = {
            countryCode: testCountryCode,
            phone: testPhone,
            faceBase64: sampleFaceFromJSON.faceBase64,
            masterPassword: sampleFaceFromJSON.password,
            identificationMethod: "phone",
        };

        const response = await request(API_BASE_URL).post("/api/clients/auth").set("Origin", "https://test.example.com").send(authData);

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty("data");
        expect(response.body.data).toHaveProperty("token");
        expect(response.body.data).toHaveProperty("zelfProof");
        expect(response.body.data).toHaveProperty("zelfAccount");
    });

    describe("4. PUT /api/clients/sync - Update Account", () => {
        it("should update client account with valid data", async () => {
            const updateData = {
                name: "Updated Test Client",
                language: "es",
                faceBase64: sampleFaceFromJSON.faceBase64,
                masterPassword: sampleFaceFromJSON.password,
            };

            const response = await request(API_BASE_URL)
                .put("/api/clients/sync")
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send(updateData);

            expect(response.status).toBe(200);
            expect(response.body.data).toHaveProperty("message", "Account updated successfully");
            expect(response.body.data).toHaveProperty("zelfAccount");
            expect(response.body.data).toHaveProperty("zelfProof");

            // Validate zelfAccount structure
            expect(response.body.data.zelfAccount).toHaveProperty("publicData");
            expect(response.body.data.zelfAccount.publicData).toHaveProperty("accountName", "Updated Test Client");
            expect(response.body.data.zelfAccount.publicData).toHaveProperty("accountEmail", testEmail);
            expect(response.body.data.zelfAccount.publicData).toHaveProperty("accountPhone", testPhone);
            expect(response.body.data.zelfAccount.publicData).toHaveProperty("accountCountryCode", testCountryCode);
            expect(response.body.data.zelfAccount.publicData).toHaveProperty("accountCompany", "Test Company");
            expect(response.body.data.zelfAccount.publicData).toHaveProperty("accountType", "client_account");
        });
    });

    describe("5. PUT /api/clients/sync/password - Change Password", () => {
        it("should change password with valid data", async () => {
            const passwordData = {
                newPassword: "NewSecurePassword123",
                confirmPassword: "NewSecurePassword123",
                faceBase64: sampleFaceFromJSON.faceBase64,
                masterPassword: sampleFaceFromJSON.password,
            };

            const response = await request(API_BASE_URL)
                .put("/api/clients/sync/password")
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send(passwordData);

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty("data");
            expect(response.body.data).toHaveProperty("message", "Password updated successfully");
            expect(response.body.data).toHaveProperty("zelfProof");
            expect(response.body.data).toHaveProperty("zelfAccount");

            // Validate zelfAccount structure
            expect(response.body.data.zelfAccount).toHaveProperty("publicData");
            expect(response.body.data.zelfAccount.publicData).toHaveProperty("accountEmail", testEmail);
            expect(response.body.data.zelfAccount.publicData).toHaveProperty("accountPhone", testPhone);
            expect(response.body.data.zelfAccount.publicData).toHaveProperty("accountCountryCode", testCountryCode);
            expect(response.body.data.zelfAccount.publicData).toHaveProperty("accountCompany", "Test Company");
            expect(response.body.data.zelfAccount.publicData).toHaveProperty("accountType", "client_account");

            // delay 1 second
            await new Promise((resolve) => setTimeout(resolve, 1000));
        });

        it("should change password back to original for subsequent tests", async () => {
            const passwordData = {
                masterPassword: "NewSecurePassword123",
                newPassword: sampleFaceFromJSON.password,
                confirmPassword: sampleFaceFromJSON.password,
                faceBase64: sampleFaceFromJSON.faceBase64,
            };

            const response = await request(API_BASE_URL)
                .put("/api/clients/sync/password")
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send(passwordData);

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty("data");
            expect(response.body.data).toHaveProperty("message", "Password updated successfully");
            expect(response.body.data).toHaveProperty("zelfProof");
            expect(response.body.data).toHaveProperty("zelfAccount");

            // delay 1 second
            await new Promise((resolve) => setTimeout(resolve, 1000));
        });

        it("should fail password change with mismatched passwords", async () => {
            const passwordData = {
                currentPassword: sampleFaceFromJSON.password,
                newPassword: "NewSecurePassword123",
                confirmPassword: "DifferentPassword123",
                faceBase64: sampleFaceFromJSON.faceBase64,
                masterPassword: sampleFaceFromJSON.password,
            };

            const response = await request(API_BASE_URL)
                .put("/api/clients/sync/password")
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send(passwordData);

            expect(response.status).toBe(409);
            expect(response.body).toHaveProperty("message", "passwords_do_not_match");
            expect(response.body).toHaveProperty("code", "Conflict");
        });
    });

    describe("6. DELETE /api/clients - Delete Account", () => {
        it("should fail to delete client with invalid credentials (not owner)", async () => {
            const response = await request(API_BASE_URL)
                .delete(`/api/clients`)
                .send({
                    accountEmail: "different@example.com",
                    masterPassword: "wrongpassword",
                    faceBase64: sampleFaceFromJSON.faceBase64,
                })
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`);

            expect(response.status).toBe(500);
            expect(response.body).toHaveProperty("code", "InternalServerError");
            expect(response.body).toHaveProperty("message", "THE PROVIDED PASSWORD IS INVALID.");
        });

        it("should delete client account with valid credentials", async () => {
            const response = await request(API_BASE_URL)
                .delete(`/api/clients`)
                .send({
                    accountEmail,
                    masterPassword: sampleFaceFromJSON.password,
                    faceBase64: sampleFaceFromJSON.faceBase64,
                })
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`);

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty("data");
            expect(response.body.data).toHaveProperty("message", "Client deleted successfully");
            expect(response.body.data).toHaveProperty("deletedFiles");
            expect(response.body.data).toHaveProperty("zelfAccount");

            // Validate deletedFiles structure
            expect(response.body.data.deletedFiles).toBeDefined();
            expect(Array.isArray(response.body.data.deletedFiles)).toBe(true);

            // Validate zelfAccount structure
            expect(response.body.data.zelfAccount).toBeDefined();
            expect(response.body.data.zelfAccount).toHaveProperty("cid");
            expect(response.body.data.zelfAccount).toHaveProperty("url");
            expect(response.body.data.zelfAccount).toHaveProperty("publicData");
        });
    });

    it("should fail to delete non-existent client", async () => {
        const response = await request(API_BASE_URL)
            .delete("/api/clients")
            .set("Origin", "https://test.example.com")
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                masterPassword: sampleFaceFromJSON.password,
                faceBase64: sampleFaceFromJSON.faceBase64,
            });

        expect(response.status).toBe(404);
        expect(response.body).toHaveProperty("code", "NotFound");
        expect(response.body).toHaveProperty("message", "client_not_found");
    });

    it("should fail to delete with missing API key", async () => {
        const response = await request(API_BASE_URL).delete(`/api/clients`).set("Origin", "https://test.example.com");

        expect(response.status).toBe(401);
        expect(response.body).toHaveProperty("error", "Protected resource, use Authorization header to get access");
    });

    describe("7. Verify Account After Deletion", () => {
        it("should confirm client no longer exists after deletion", async () => {
            const response = await request(API_BASE_URL).get("/api/clients").query({ email: testEmail });
            expect(response.status).toBe(404);
            expect(response.body).toHaveProperty("code", "NotFound");
            expect(response.body).toHaveProperty("message", "client_not_found");
        });
    });
});
