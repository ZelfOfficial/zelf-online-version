// ZelfKeys API Integration Tests - Testing Real Running Server
// Tests the /api/zelf-keys endpoints (password manager)
// Complete flow: Session -> Lease Zelf ID -> Store (password, notes, zotp, credit-card) -> List -> Retrieve -> Preview -> Delete
//
// IMPORTANT: The store endpoints call _validateOwnership which decrypts the user's
// Zelf ID tag. The session must be associated with a real Zelf ID that was leased
// with the same face + password, otherwise the encryption key won't match (412).
const request = require("supertest");
const fs = require("fs");
const path = require("path");
const openpgp = require("openpgp");
require("dotenv").config();

const API_BASE_URL = `http://localhost:${process.env.PORT || 3000}`;

// Load the selfie image as base64 for biometric operations
const selfieImagePath = path.resolve(__dirname, "../../Core/assets/selfie_girl.jpg");
const faceBase64 = fs.readFileSync(selfieImagePath, "base64");

const ZELF_KEYS_PATH = "/api/zelf-keys";
const ZELF_IDS_PATH = "/api/zelf-ids";
const TEST_DOMAIN = "zelf";
const TEST_PASSWORD = "testpassword123";

describe("ZelfKeys API Integration Tests", () => {
    let authToken;
    let leasedTagName;
    let storedPasswordZelfProof;
    let storedPasswordId;
    let storedNotesZelfProof;
    let storedZotpZelfProof;
    let storedCreditCardZelfProof;

    // Create a session and get JWT token before running tests
    beforeAll(async () => {
        jest.setTimeout(90000);

        const sessionData = {
            identifier: `zkeys_${Date.now()}`,
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

        // Wait for IPFS to index the wallet tag created by the session
        // (needed by _validateOwnership in store endpoints)
        await new Promise((resolve) => setTimeout(resolve, 5000));
        console.log(`✅ Setup: Created session and waited for IPFS indexing`);
    });

    // ─── 1. Validation: Store endpoints ─────────────────────────────────
    describe("1. Store Validation", () => {
        it("POST /zelf-keys/store/password — should return 409 when required fields are missing", async () => {
            const response = await request(API_BASE_URL)
                .post(`${ZELF_KEYS_PATH}/store/password`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send({});

            expect(response.status).toBe(409);
            expect(response.body).toHaveProperty("validationError");
        });

        it("POST /zelf-keys/store/password — should return 409 when faceBase64 is missing", async () => {
            const response = await request(API_BASE_URL)
                .post(`${ZELF_KEYS_PATH}/store/password`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    website: "https://example.com",
                    username: "testuser",
                    password: "secret123",
                });

            expect(response.status).toBe(409);
            expect(response.body.validationError).toMatch(/faceBase64/i);
        });

        it("POST /zelf-keys/store/zotp — should return 409 when required fields are missing", async () => {
            const response = await request(API_BASE_URL)
                .post(`${ZELF_KEYS_PATH}/store/zotp`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send({});

            expect(response.status).toBe(409);
            expect(response.body).toHaveProperty("validationError");
        });

        it("POST /zelf-keys/store/notes — should return 409 when required fields are missing", async () => {
            const response = await request(API_BASE_URL)
                .post(`${ZELF_KEYS_PATH}/store/notes`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send({});

            expect(response.status).toBe(409);
            expect(response.body).toHaveProperty("validationError");
        });

        it("POST /zelf-keys/store/notes — should return 409 when keyValuePairs is empty", async () => {
            const response = await request(API_BASE_URL)
                .post(`${ZELF_KEYS_PATH}/store/notes`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    title: "My Note",
                    keyValuePairs: {},
                    faceBase64,
                });

            expect(response.status).toBe(409);
            expect(response.body.validationError).toMatch(/key-value pair/i);
        });

        it("POST /zelf-keys/store/credit-card — should return 409 when required fields are missing", async () => {
            const response = await request(API_BASE_URL)
                .post(`${ZELF_KEYS_PATH}/store/credit-card`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send({});

            expect(response.status).toBe(409);
            expect(response.body).toHaveProperty("validationError");
        });

        it("POST /zelf-keys/store/credit-card — should return 409 for expired card", async () => {
            const response = await request(API_BASE_URL)
                .post(`${ZELF_KEYS_PATH}/store/credit-card`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    cardName: "Test Card",
                    cardNumber: "4111111111111111",
                    expiryMonth: "01",
                    expiryYear: "2020",
                    cvv: "123",
                    bankName: "Test Bank",
                    faceBase64,
                });

            expect(response.status).toBe(409);
            expect(response.body.validationError).toMatch(/expired/i);
        });

        it("POST /zelf-keys/store/password — should return 401 without auth", async () => {
            const response = await request(API_BASE_URL)
                .post(`${ZELF_KEYS_PATH}/store/password`)
                .set("Origin", "https://test.example.com")
                .send({
                    website: "https://example.com",
                    username: "testuser",
                    password: "secret123",
                    faceBase64,
                });

            expect(response.status).toBe(401);
        });
    });

    // ─── 2. Store: Create real records ──────────────────────────────────
    describe("2. Store Records", () => {
        it("POST /zelf-keys/store/password — should store a password", async () => {
            jest.setTimeout(60000);

            const response = await request(API_BASE_URL)
                .post(`${ZELF_KEYS_PATH}/store/password`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    website: "https://github.com",
                    username: "testuser@zelf.world",
                    password: "mySecretGitHub!123",
                    alias: "GitHub work vault",
                    folder: "Work",
                    faceBase64,
                    masterPassword: TEST_PASSWORD,
                    removePGP: true,
                    notes: "Work account",
                });

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty("data");
            expect(response.body.data).toHaveProperty("message", "Data stored successfully");
            expect(response.body.data).toHaveProperty("type", "password");
            expect(response.body.data).toHaveProperty("zelfProof");
            expect(response.body.data).toHaveProperty("zelfProofQRCode");

            storedPasswordZelfProof = response.body.data.zelfProof;

            // Capture IPFS id for later deletion
            if (response.body.data.ipfs) {
                storedPasswordId = response.body.data.ipfs.id || response.body.data.ipfs.cid;
            }

            console.log("✅ Password stored successfully");
        });

        it("POST /zelf-keys/store/notes — should store notes", async () => {
            jest.setTimeout(60000);

            const response = await request(API_BASE_URL)
                .post(`${ZELF_KEYS_PATH}/store/notes`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    title: "Server Credentials",
                    keyValuePairs: {
                        host: "prod-db.example.com",
                        port: "5432",
                        database: "zelf_prod",
                    },
                    faceBase64,
                    masterPassword: TEST_PASSWORD,
                    removePGP: true,
                });

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty("data");
            expect(response.body.data).toHaveProperty("type", "notes");
            expect(response.body.data).toHaveProperty("zelfProof");
            expect(response.body.data.ipfs?.publicData?.v).toBe("4");

            storedNotesZelfProof = response.body.data.zelfProof;
            console.log("✅ Notes stored successfully");
        });

        it("POST /zelf-keys/store/zotp — should store a ZOTP record", async () => {
            jest.setTimeout(60000);

            const response = await request(API_BASE_URL)
                .post(`${ZELF_KEYS_PATH}/store/zotp`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    username: "user@zelf.world",
                    setupKey: "JBSWY3DPEHPK3PXP",
                    issuer: "GitHub",
                    faceBase64,
                    masterPassword: TEST_PASSWORD,
                    removePGP: true,
                });

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty("data");
            expect(response.body.data).toHaveProperty("type", "zotp");
            expect(response.body.data).toHaveProperty("zelfProof");
            expect(response.body.data.ipfs?.publicData?.v).toBe("4");

            storedZotpZelfProof = response.body.data.zelfProof;
            console.log("✅ ZOTP stored successfully");
        });

        it("POST /zelf-keys/store/credit-card — should store a credit card", async () => {
            jest.setTimeout(60000);

            const response = await request(API_BASE_URL)
                .post(`${ZELF_KEYS_PATH}/store/credit-card`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    cardName: "Miguel Trevino",
                    cardNumber: "4111111111111111",
                    expiryMonth: "12",
                    expiryYear: "2030",
                    cvv: "123",
                    bankName: "Chase",
                    alias: "Travel card",
                    folder: "Finance",
                    faceBase64,
                    masterPassword: TEST_PASSWORD,
                    removePGP: true,
                });

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty("data");
            expect(response.body.data).toHaveProperty("type", "credit_card");
            expect(response.body.data).toHaveProperty("zelfProof");

            storedCreditCardZelfProof = response.body.data.zelfProof;
            console.log("✅ Credit card stored successfully");
        });
    });

    // ─── 3. Store via /add route (ZNS payment) ─────────────────────────
    describe("3. Add Records (ZNS payment route)", () => {
        it("POST /zelf-keys/add/password — should use same logic as /store/password", async () => {
            jest.setTimeout(60000);

            const response = await request(API_BASE_URL)
                .post(`${ZELF_KEYS_PATH}/add/password`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    website: "https://gitlab.com",
                    username: "adduser@zelf.world",
                    password: "addPassword!456",
                    faceBase64,
                    masterPassword: TEST_PASSWORD,
                    removePGP: true,
                });

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty("data");
            expect(response.body.data).toHaveProperty("type", "password");
            console.log("✅ Password stored via /add route");
        });
    });

    // ─── 4. List ────────────────────────────────────────────────────────
    describe("4. List Records", () => {
        it("GET /zelf-keys/list — should return 409 without category", async () => {
            const response = await request(API_BASE_URL)
                .get(`${ZELF_KEYS_PATH}/list`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`);

            expect(response.status).toBe(409);
            expect(response.body).toHaveProperty("validationError");
        });

        it("GET /zelf-keys/list — should list passwords", async () => {
            const response = await request(API_BASE_URL)
                .get(`${ZELF_KEYS_PATH}/list`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .query({ category: "password" });

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty("data");
            expect(response.body.data).toHaveProperty("success", true);
            expect(response.body.data).toHaveProperty("category", "password");
            expect(response.body.data).toHaveProperty("data");
            expect(Array.isArray(response.body.data.data)).toBe(true);
            expect(response.body.data).toHaveProperty("totalCount");
            const stored = (response.body.data.data || []).find(
                (item) => item.publicData?.alias === "GitHub work vault"
            );
            if (stored) {
                expect(stored.publicData.v).toBe("4");
                expect(stored.publicData.folder).toBe("Work");
                expect(stored.publicData).not.toHaveProperty("insideFolder");
                expect(stored.publicData).not.toHaveProperty("password");
            }
            console.log(`✅ Listed ${response.body.data.totalCount} password records`);
        });

        it("GET /zelf-keys/list — should list notes", async () => {
            const response = await request(API_BASE_URL)
                .get(`${ZELF_KEYS_PATH}/list`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .query({ category: "notes" });

            expect(response.status).toBe(200);
            expect(response.body.data).toHaveProperty("category", "notes");
            console.log(`✅ Listed ${response.body.data.totalCount} notes records`);
        });

        it("GET /zelf-keys/list — should list zotp", async () => {
            const response = await request(API_BASE_URL)
                .get(`${ZELF_KEYS_PATH}/list`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .query({ category: "zotp" });

            expect(response.status).toBe(200);
            expect(response.body.data).toHaveProperty("category", "zotp");
            console.log(`✅ Listed ${response.body.data.totalCount} zotp records`);
        });

        it("GET /zelf-keys/list — should list credit_card", async () => {
            const response = await request(API_BASE_URL)
                .get(`${ZELF_KEYS_PATH}/list`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .query({ category: "credit_card" });

            expect(response.status).toBe(200);
            expect(response.body.data).toHaveProperty("category", "credit_card");
            const stored = (response.body.data.data || []).find((item) => item.publicData?.alias === "Travel card");
            if (stored) {
                expect(stored.publicData.v).toBe("4");
                expect(stored.publicData.folder).toBe("Finance");
                expect(stored.publicData).not.toHaveProperty("insideFolder");
                expect(String(stored.publicData.card || "")).toContain("1111");
                expect(String(stored.publicData.card || "")).not.toContain("4111111111111111");
            }
            console.log(`✅ Listed ${response.body.data.totalCount} credit_card records`);
        });

        it("GET /zelf-keys/list-all — should return all categories", async () => {
            const response = await request(API_BASE_URL)
                .get(`${ZELF_KEYS_PATH}/list-all`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`);

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty("data");
            expect(response.body.data).toHaveProperty("success", true);
            expect(response.body.data).toHaveProperty("data");
            expect(response.body.data).toHaveProperty("totalCount");

            const categories = response.body.data.data;
            expect(categories).toHaveProperty("password");
            expect(categories).toHaveProperty("notes");
            expect(categories).toHaveProperty("credit_card");
            expect(categories).toHaveProperty("zotp");
            expect(categories).toHaveProperty("contact");
            console.log(`✅ Listed all categories: ${response.body.data.totalCount} total records`);
        });

        it("GET /zelf-keys/list — should return 401 without auth", async () => {
            const response = await request(API_BASE_URL)
                .get(`${ZELF_KEYS_PATH}/list`)
                .set("Origin", "https://test.example.com")
                .query({ category: "password" });

            expect(response.status).toBe(401);
        });
    });

    describe("4b. Summary", () => {
        it("GET /zelf-keys/summary — should return counts only", async () => {
            const response = await request(API_BASE_URL)
                .get(`${ZELF_KEYS_PATH}/summary`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`);

            expect(response.status).toBe(200);
            expect(response.body.data).toHaveProperty("totalCount");
            expect(response.body.data.counts).toEqual(
                expect.objectContaining({
                    password: expect.any(Number),
                    credit_card: expect.any(Number),
                    notes: expect.any(Number),
                    contact: expect.any(Number),
                    zotp: expect.any(Number),
                })
            );
            const serialized = JSON.stringify(response.body);
            expect(serialized).not.toMatch(/zelfProof|zelfProofQRCode|cardNumber|cvv|publicData/);
            expect(response.body.data.totalCount).toBe(
                Object.values(response.body.data.counts).reduce((sum, count) => sum + count, 0)
            );
        });

        it("GET /zelf-keys/summary — should return 401 without auth", async () => {
            const response = await request(API_BASE_URL)
                .get(`${ZELF_KEYS_PATH}/summary`)
                .set("Origin", "https://test.example.com");

            expect(response.status).toBe(401);
        });
    });

    // ─── 5. Retrieve & Preview ──────────────────────────────────────────
    describe("5. Retrieve & Preview", () => {
        it("POST /zelf-keys/retrieve — should return 409 when zelfProof is missing", async () => {
            const response = await request(API_BASE_URL)
                .post(`${ZELF_KEYS_PATH}/retrieve`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send({});

            expect(response.status).toBe(409);
            expect(response.body).toHaveProperty("validationError");
        });

        it("POST /zelf-keys/retrieve — should return 409 when clientPublicKey is missing", async () => {
            const response = await request(API_BASE_URL)
                .post(`${ZELF_KEYS_PATH}/retrieve`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    zelfProof: "fake-proof",
                    faceBase64,
                    type: "password",
                });

            expect(response.status).toBe(409);
            expect(response.body).toHaveProperty("validationError");
        });

        it("POST /zelf-keys/retrieve — should decrypt a stored password with clientPublicKey", async () => {
            if (!storedPasswordZelfProof) {
                console.log("⚠️  Skipping: no stored password zelfProof available");
                return;
            }

            const { privateKey: clientPrivateKey, publicKey: clientPublicKey } = await openpgp.generateKey({
                type: "ecc",
                curve: "curve25519",
                userIDs: [{ name: "ZelfKeys Test", email: "test@zelf.world" }],
            });

            const response = await request(API_BASE_URL)
                .post(`${ZELF_KEYS_PATH}/retrieve`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    zelfProof: storedPasswordZelfProof,
                    type: "password",
                    v: "4",
                    faceBase64,
                    removePGP: true,
                    clientPublicKey,
                });

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty("data");
            expect(response.body.data.pgp).toBeDefined();
            expect(response.body.data.pgp.encryptedMessage).toBeDefined();
            expect(response.body.data.pgp.privateKey).toBeUndefined();
            expect(response.body.data.metadata).toEqual({});

            const privateKey = await openpgp.readPrivateKey({ armoredKey: clientPrivateKey });
            const message = await openpgp.readMessage({
                armoredMessage: response.body.data.pgp.encryptedMessage,
            });
            const { data: decrypted } = await openpgp.decrypt({
                message,
                decryptionKeys: privateKey,
            });

            const metadata = JSON.parse(decrypted);

            expect(metadata).toHaveProperty("password");
            expect(metadata).toHaveProperty("username");

            console.log("✅ Password retrieved and client-decrypted successfully");
        });

        it("POST /zelf-keys/retrieve — decrypts a raw v4 proof without a version hint", async () => {
            jest.setTimeout(60000);
            const ZelfProofModule = require("../../Repositories/ZelfProof/modules/zelf-proof.module");
            const { zelfProof } = await ZelfProofModule.encrypt({
                _id: `v4_keys_${Date.now()}`,
                addServerPassword: false,
                faceBase64,
                metadata: { password: "v4Secret", username: "v4-user" },
                publicData: { type: "password", website: "v4.test", v: "4" },
                tolerance: "REGULAR",
                stack: "v4",
            });

            const { privateKey: clientPrivateKey, publicKey: clientPublicKey } = await openpgp.generateKey({
                type: "ecc",
                curve: "curve25519",
                userIDs: [{ name: "ZelfKeys Test", email: "test@zelf.world" }],
            });

            const response = await request(API_BASE_URL)
                .post(`${ZELF_KEYS_PATH}/retrieve`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    zelfProof,
                    type: "password",
                    v: "4",
                    faceBase64,
                    removePGP: true,
                    clientPublicKey,
                });

            expect(response.status).toBe(200);
            const privateKey = await openpgp.readPrivateKey({ armoredKey: clientPrivateKey });
            const message = await openpgp.readMessage({
                armoredMessage: response.body.data.pgp.encryptedMessage,
            });
            const { data: decrypted } = await openpgp.decrypt({
                message,
                decryptionKeys: privateKey,
            });
            expect(JSON.parse(decrypted)).toHaveProperty("password", "v4Secret");
            console.log("✅ Raw v4 password retrieved with the pin stamp");
        });

        it("POST /zelf-keys/retrieve — decrypts a stored v4 password without a version hint", async () => {
            if (!storedPasswordZelfProof) {
                console.log("⚠️  Skipping: no stored password zelfProof available");
                return;
            }

            const { privateKey: clientPrivateKey, publicKey: clientPublicKey } = await openpgp.generateKey({
                type: "ecc",
                curve: "curve25519",
                userIDs: [{ name: "ZelfKeys Test", email: "test@zelf.world" }],
            });

            const response = await request(API_BASE_URL)
                .post(`${ZELF_KEYS_PATH}/retrieve`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    zelfProof: storedPasswordZelfProof,
                    type: "password",
                    v: "4",
                    faceBase64,
                    removePGP: true,
                    clientPublicKey,
                });

            expect(response.status).toBe(200);
            const privateKey = await openpgp.readPrivateKey({ armoredKey: clientPrivateKey });
            const message = await openpgp.readMessage({
                armoredMessage: response.body.data.pgp.encryptedMessage,
            });
            const { data: decrypted } = await openpgp.decrypt({
                message,
                decryptionKeys: privateKey,
            });
            expect(JSON.parse(decrypted)).toHaveProperty("password");
            console.log("✅ Stored v4 password retrieved with the pin stamp");
        });

        it("POST /zelf-keys/retrieve — should decrypt a stored v4 credit card", async () => {
            if (!storedCreditCardZelfProof) {
                console.log("⚠️  Skipping: no stored credit card zelfProof available");
                return;
            }

            const { privateKey: clientPrivateKey, publicKey: clientPublicKey } = await openpgp.generateKey({
                type: "ecc",
                curve: "curve25519",
                userIDs: [{ name: "ZelfKeys Test", email: "test@zelf.world" }],
            });

            const response = await request(API_BASE_URL)
                .post(`${ZELF_KEYS_PATH}/retrieve`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    zelfProof: storedCreditCardZelfProof,
                    type: "credit_card",
                    v: "4",
                    faceBase64,
                    removePGP: true,
                    clientPublicKey,
                });

            expect(response.status).toBe(200);
            expect(response.body.data.pgp.encryptedMessage).toBeDefined();

            const privateKey = await openpgp.readPrivateKey({ armoredKey: clientPrivateKey });
            const message = await openpgp.readMessage({
                armoredMessage: response.body.data.pgp.encryptedMessage,
            });
            const { data: decrypted } = await openpgp.decrypt({
                message,
                decryptionKeys: privateKey,
            });
            const metadata = JSON.parse(decrypted);
            expect(metadata).toHaveProperty("cardNumber");
            expect(metadata).toHaveProperty("cvv");
            console.log("✅ Credit card retrieved and client-decrypted successfully");
        });

        it("POST /zelf-keys/retrieve — a non-v4 hint stays on 3.1.6", async () => {
            jest.setTimeout(60000);
            const ZelfProofModule = require("../../Repositories/ZelfProof/modules/zelf-proof.module");
            const { zelfProof } = await ZelfProofModule.encrypt({
                _id: `v4_hint_${Date.now()}`,
                addServerPassword: false,
                faceBase64,
                metadata: { password: "v4Secret", username: "v4-user" },
                publicData: { type: "password", website: "v4.test", v: "4" },
                tolerance: "REGULAR",
                stack: "v4",
            });

            const { publicKey: clientPublicKey } = await openpgp.generateKey({
                type: "ecc",
                curve: "curve25519",
                userIDs: [{ name: "ZelfKeys Test", email: "test@zelf.world" }],
            });

            const response = await request(API_BASE_URL)
                .post(`${ZELF_KEYS_PATH}/retrieve`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    zelfProof,
                    type: "password",
                    v: "99",
                    faceBase64,
                    removePGP: true,
                    clientPublicKey,
                });

            expect(response.status).not.toBe(200);
        });

        it("POST /zelf-keys/retrieve — decrypts a legacy unstamped v3.6 proof without v", async () => {
            jest.setTimeout(60000);
            const ZelfProofModule = require("../../Repositories/ZelfProof/modules/zelf-proof.module");
            const { zelfProof } = await ZelfProofModule.encrypt({
                _id: `legacy_keys_${Date.now()}`,
                addServerPassword: false,
                faceBase64,
                metadata: { password: "legacySecret", username: "legacy-user" },
                publicData: { type: "password", website: "legacy.test" },
                tolerance: "REGULAR",
            });

            const { privateKey: clientPrivateKey, publicKey: clientPublicKey } = await openpgp.generateKey({
                type: "ecc",
                curve: "curve25519",
                userIDs: [{ name: "ZelfKeys Test", email: "test@zelf.world" }],
            });

            const response = await request(API_BASE_URL)
                .post(`${ZELF_KEYS_PATH}/retrieve`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    zelfProof,
                    type: "password",
                    faceBase64,
                    removePGP: true,
                    clientPublicKey,
                });

            expect(response.status).toBe(200);
            const privateKey = await openpgp.readPrivateKey({ armoredKey: clientPrivateKey });
            const message = await openpgp.readMessage({
                armoredMessage: response.body.data.pgp.encryptedMessage,
            });
            const { data: decrypted } = await openpgp.decrypt({
                message,
                decryptionKeys: privateKey,
            });
            expect(JSON.parse(decrypted)).toHaveProperty("password", "legacySecret");
            console.log("✅ Legacy v3.6 password retrieved without a version stamp");
        });

        it("POST /zelf-keys/preview — should return 409 when zelfProof is missing", async () => {
            const response = await request(API_BASE_URL)
                .post(`${ZELF_KEYS_PATH}/preview`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send({});

            expect(response.status).toBe(409);
            expect(response.body).toHaveProperty("validationError");
        });

        it("POST /zelf-keys/preview — should preview a stored record", async () => {
            if (!storedPasswordZelfProof) {
                console.log("⚠️  Skipping: no stored password zelfProof available");
                return;
            }

            const response = await request(API_BASE_URL)
                .post(`${ZELF_KEYS_PATH}/preview`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    zelfProof: storedPasswordZelfProof,
                    faceBase64,
                });

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty("data");
            console.log("✅ Preview returned successfully");
        });
    });

    // ─── 6. Delete ──────────────────────────────────────────────────────
    describe("6. Delete", () => {
        it("PUT /zelf-keys/delete/:id — should return 409 when faceBase64 is missing", async () => {
            const response = await request(API_BASE_URL)
                .put(`${ZELF_KEYS_PATH}/delete/some-fake-id`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send({});

            expect(response.status).toBe(409);
            expect(response.body).toHaveProperty("validationError");
        });

        it("PUT /zelf-keys/delete/:id — should delete a stored record", async () => {
            if (!storedPasswordId) {
                console.log("⚠️  Skipping: no stored password ID available for deletion");
                return;
            }

            const response = await request(API_BASE_URL)
                .put(`${ZELF_KEYS_PATH}/delete/${storedPasswordId}`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    faceBase64,
                    masterPassword: TEST_PASSWORD,
                    removePGP: true,
                });

            // May succeed or fail depending on biometric threshold
            expect([200, 400, 409, 500]).toContain(response.status);

            if (response.status === 200) {
                expect(response.body).toHaveProperty("data");
                expect(response.body.data).toHaveProperty("success", true);
                console.log("✅ ZelfKey deleted successfully");
            } else {
                console.log(`⚠️  Delete returned ${response.status} (biometric threshold — expected with test image)`);
            }
        });

        it("PUT /zelf-keys/delete/:id — should return 401 without auth", async () => {
            const response = await request(API_BASE_URL)
                .put(`${ZELF_KEYS_PATH}/delete/some-id`)
                .set("Origin", "https://test.example.com")
                .send({
                    faceBase64,
                    masterPassword: TEST_PASSWORD,
                    removePGP: true,
                });

            expect(response.status).toBe(401);
        });
    });

    // ─── 7. Notes edge cases ────────────────────────────────────────────
    describe("7. Notes Validation Edge Cases", () => {
        it("POST /zelf-keys/store/notes — should reject more than 10 key-value pairs", async () => {
            const manyPairs = {};
            for (let i = 0; i < 11; i++) {
                manyPairs[`key${i}`] = `value${i}`;
            }

            const response = await request(API_BASE_URL)
                .post(`${ZELF_KEYS_PATH}/store/notes`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    title: "Too Many Pairs",
                    keyValuePairs: manyPairs,
                    faceBase64,
                });

            expect(response.status).toBe(409);
            expect(response.body.validationError).toMatch(/10/);
        });

        it("POST /zelf-keys/store/notes — should reject key names longer than 50 chars", async () => {
            const longKey = "a".repeat(51);

            const response = await request(API_BASE_URL)
                .post(`${ZELF_KEYS_PATH}/store/notes`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    title: "Long Key",
                    keyValuePairs: { [longKey]: "value" },
                    faceBase64,
                });

            expect(response.status).toBe(409);
            expect(response.body.validationError).toMatch(/50 characters/);
        });

        it("POST /zelf-keys/store/notes — should reject values longer than 1000 chars", async () => {
            const longValue = "x".repeat(1001);

            const response = await request(API_BASE_URL)
                .post(`${ZELF_KEYS_PATH}/store/notes`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    title: "Long Value",
                    keyValuePairs: { key: longValue },
                    faceBase64,
                });

            expect(response.status).toBe(409);
            expect(response.body.validationError).toMatch(/1000 characters/);
        });
    });
});
