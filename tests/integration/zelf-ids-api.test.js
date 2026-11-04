// Zelf IDs API Integration Tests — live server, real v4, no mocks.
// /api/zelf-ids is owned by Repositories/ZelfID (ZelfEncrypt v4 / /zelf-v4).
// Proofs and QRs used later in this file come from this run's lease/encrypt responses.
// Offline lease is POST /api/zelf-ids/lease-offline (v4 Human Authn preview).
const request = require("supertest");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const moment = require("moment");
require("dotenv").config();

const {
	extractZelfProofFromQR,
	QR_BYTE_CAPACITY,
} = require("../../Repositories/Tags/modules/qr-zelfproof-extractor.module");

const API_BASE_URL = `http://localhost:${process.env.PORT || 3000}`;
const ORIGIN = "https://test.example.com";
const selfieImagePath = path.resolve(__dirname, "../../Core/assets/selfie_girl.jpg");
const faceBase64 = fs.readFileSync(selfieImagePath, "base64");

const ZELF_IDS_PATH = "/api/zelf-ids";
const JWT_HUMAN_AUTHN = "/api/jwt/human-authn";
const TEST_DOMAIN = "zelf";
const TEST_PASSWORD = "testpassword123";
const RECOVERY_MNEMONIC =
	"abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const uniqueTagName = () => `zid${Math.floor(Math.random() * 100000).toString().padStart(5, "0")}`;
const shortUniqueTagName = () => `z${Math.floor(Math.random() * 10000).toString().padStart(4, "0")}`;

const previewPublicData = (body = {}) =>
	body.preview?.publicData || body.preview?.cleartext_data || body.publicData || {};

const pngFromDataUrl = (dataUrl) => {
	const raw = String(dataUrl || "").includes(",") ? dataUrl.split(",")[1] : dataUrl;
	return Buffer.from(raw, "base64");
};

describe("Zelf IDs API Integration Tests", () => {
    let authToken;

    // Create a session and get JWT token before running tests
    beforeAll(async () => {
        const sessionData = {
            identifier: `zelfids_test_${Date.now()}_${Math.random().toString(36).substring(7)}`,
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

    // ─── 1. Domain helpers ──────────────────────────────────────────────
    describe("1. Domain Helpers", () => {
        it("GET /zelf-ids/domains — should return available domains", async () => {
            const response = await request(API_BASE_URL)
                .get(`${ZELF_IDS_PATH}/domains`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`);

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty("data");
        });

        it("GET /zelf-ids/domains/zelf — should return zelf domain config", async () => {
            const response = await request(API_BASE_URL)
                .get(`${ZELF_IDS_PATH}/domains/zelf`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`);

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty("data");

            const config = response.body.data;
            const payment = config?.tags?.payment || {};
            expect(payment).toHaveProperty("pricingTable");
            const { Domain } = require("../../Repositories/Tags/modules/domain.class");
            const domain = new Domain(config);
            const fallback = domain.getPrice("abcdef.zelf", "1", "");
            const premium = domain.getPrice("abcdef.zelf", "1", "", { plan: "premium" });
            const unlimited = domain.getPrice("abcdef.zelf", "1", "", { plan: "unlimited" });
            const planPricing = payment.planPricing || {};
            const hasPlanTables =
                planPricing.premium &&
                Object.keys(planPricing.premium).length > 0 &&
                planPricing.unlimited &&
                Object.keys(planPricing.unlimited).length > 0;
            if (!hasPlanTables) {
                expect(premium.price).toBe(fallback.price);
                expect(unlimited.price).toBe(fallback.price);
            }
            expect(fallback.price).toBeGreaterThanOrEqual(0);
        });

        it("GET /zelf-ids/domains/notarealtld — should return 404", async () => {
            const response = await request(API_BASE_URL)
                .get(`${ZELF_IDS_PATH}/domains/notarealtld`)
                .set("Origin", ORIGIN)
                .set("Authorization", `Bearer ${authToken}`);

            expect(response.status).toBe(404);
            expect(response.body.message).toBe("domain_not_found");
        });
    });

    // ─── 2. Search ──────────────────────────────────────────────────────
    describe("2. Search", () => {
        it("GET /zelf-ids/search — should search for an existing tag", async () => {
            const response = await request(API_BASE_URL)
                .get(`${ZELF_IDS_PATH}/search`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .query({ tagName: "migueltrevino", domain: "zelf", os: "DESKTOP" });

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty("data");

            if (!response.body.data.available) {
                expect(response.body.data).toHaveProperty("tagObject");
                expect(response.body.data.tagObject).toHaveProperty("publicData");
            }
        });

        it("GET /zelf-ids/search — should return pricing for available name", async () => {
            const response = await request(API_BASE_URL)
                .get(`${ZELF_IDS_PATH}/search`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .query({ tagName: `avail${Date.now()}`, domain: "zelf", os: "DESKTOP" });

            expect(response.status).toBe(200);
            expect(response.body.data.available).toBe(true);
            expect(response.body.data).toHaveProperty("price");
            expect(response.body.data.price).toHaveProperty("price");
            expect(response.body.data.price).toHaveProperty("currency");
        });

        it("GET /zelf-ids/search — should return 409 when tagName is missing", async () => {
            const response = await request(API_BASE_URL)
                .get(`${ZELF_IDS_PATH}/search`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .query({ domain: "zelf", os: "DESKTOP" });

            expect(response.status).toBe(409);
            expect(response.body).toHaveProperty("validationError");
        });

        it("GET /zelf-ids/search — should return 401 without auth", async () => {
            const response = await request(API_BASE_URL)
                .get(`${ZELF_IDS_PATH}/search`)
                .set("Origin", "https://test.example.com")
                .query({ tagName: "test", domain: "zelf", os: "DESKTOP" });

            expect(response.status).toBe(401);
        });
    });

    // ─── 3. Preview ─────────────────────────────────────────────────────
    describe("3. Preview", () => {
        it("GET /zelf-ids/preview — should preview an existing name", async () => {
            const response = await request(API_BASE_URL)
                .get(`${ZELF_IDS_PATH}/preview`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .query({ tagName: "migueltrevino", domain: "zelf", os: "DESKTOP" });

            expect(response.body).toHaveProperty("data");

            if (!response.body.data.available) {
                expect(response.body.data).toHaveProperty("preview");
                expect(response.body.data).toHaveProperty("tagObject");
                expect(response.body.data.preview).toHaveProperty("passwordLayer");
                expect(response.body.data.preview).toHaveProperty("publicData");
            }
        });

        it("GET /zelf-ids/preview — should return pricing for available name", async () => {
            const response = await request(API_BASE_URL)
                .get(`${ZELF_IDS_PATH}/preview`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .query({ tagName: `prev${Date.now()}`, domain: "zelf", os: "DESKTOP" });

            expect(response.body).toHaveProperty("data");
            expect(response.body.data.available).toBe(true);
            expect(response.body.data).toHaveProperty("price");
        });

        it("GET /zelf-ids/preview — should return 409 when tagName is missing", async () => {
            const response = await request(API_BASE_URL)
                .get(`${ZELF_IDS_PATH}/preview`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .query({ domain: "zelf", os: "DESKTOP" });

            expect(response.status).toBe(409);
            expect(response.body).toHaveProperty("validationError");
        });
    });

    // ─── 4. Full Lifecycle: lease one v4 ID, reuse that proof/QR ────────
    describe("4. Full Lifecycle: Lease -> v4 preview/QR -> Decrypt -> Delete", () => {
        jest.setTimeout(180000);

        let tagName;
        let zelfProof;
        let zelfProofQRCode;
        let publicData;

        it("POST /zelf-ids/lease — stamps origin online and v 4", async () => {
            tagName = uniqueTagName();

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
            expect(leaseResponse.body).toHaveProperty("data");

            const leasedData = leaseResponse.body.data;
            expect(leasedData).toHaveProperty("tagObject");
            expect(leasedData.tagObject).toHaveProperty("publicData");
            expect(leasedData.tagObject).toHaveProperty("zelfProof");
            expect(leasedData.tagObject).toHaveProperty("zelfProofQRCode");

            publicData = leasedData.tagObject.publicData;
            zelfProof = leasedData.tagObject.zelfProof;
            zelfProofQRCode = leasedData.tagObject.zelfProofQRCode;

            expect(publicData).toHaveProperty("ethAddress");
            expect(publicData).toHaveProperty("btcAddress");
            expect(publicData).toHaveProperty("solanaAddress");
            expect(publicData.origin).toBe("online");
            expect(Number(publicData.v)).toBe(4);
            expect(typeof zelfProof).toBe("string");
            expect(zelfProof.length).toBeGreaterThan(0);
            expect(leasedData.walrus).toBeFalsy();
        });

        it("leased QR is a PNG, 800px when past H, and scans back to the same proof", async () => {
            expect(zelfProof).toBeDefined();
            expect(zelfProofQRCode).toMatch(/^data:image\/png;base64,/);

            const proofBytes = Buffer.from(zelfProof, "base64").length;
            const meta = await sharp(pngFromDataUrl(zelfProofQRCode)).metadata();
            expect(meta.format).toBe("png");

            if (proofBytes > QR_BYTE_CAPACITY.H) {
                expect(meta.width).toBe(800);
                expect(meta.height).toBe(800);
            } else {
                expect(meta.width).toBeLessThanOrEqual(640);
                expect(meta.height).toBeLessThanOrEqual(640);
            }

            const scanned = await extractZelfProofFromQR(zelfProofQRCode);
            expect(scanned).toBe(zelfProof);
        });

        it("POST /zelf-ids/preview-zelfproof — v4 preview of the leased proof", async () => {
            const response = await request(API_BASE_URL)
                .post(`${ZELF_IDS_PATH}/preview-zelfproof`)
                .set("Origin", ORIGIN)
                .set("Authorization", `Bearer ${authToken}`)
                .send({ zelfProof, os: "DESKTOP" });

            expect(response.status).toBe(200);
            const previewed = previewPublicData(response.body.data);
            expect(Number(previewed.v)).toBe(4);
            expect(previewed.origin).toBe("online");
            expect(previewed.ethAddress).toBe(publicData.ethAddress);
        });

        it("POST /zelf-ids/preview-zelf-id-qr — v4 preview of the leased QR", async () => {
            const response = await request(API_BASE_URL)
                .post(`${ZELF_IDS_PATH}/preview-zelf-id-qr`)
                .set("Origin", ORIGIN)
                .set("Authorization", `Bearer ${authToken}`)
                .send({ zelfProofQRCode, os: "DESKTOP" });

            expect(response.status).toBe(200);
            const previewed = previewPublicData(response.body.data);
            expect(Number(previewed.v)).toBe(4);
            expect(previewed.origin).toBe("online");
            expect(previewed.ethAddress).toBe(publicData.ethAddress);
        });

        it("GET /zelf-ids/preview — leased name returns a v4 preview", async () => {
            let found = false;
            for (let attempt = 0; attempt < 8 && !found; attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 2000));
                const response = await request(API_BASE_URL)
                    .get(`${ZELF_IDS_PATH}/preview`)
                    .set("Origin", ORIGIN)
                    .set("Authorization", `Bearer ${authToken}`)
                    .query({ tagName, domain: TEST_DOMAIN, os: "DESKTOP" });

                if (response.status === 200 && response.body.data && !response.body.data.available) {
                    expect(response.body.data).toHaveProperty("preview");
                    expect(response.body.data).toHaveProperty("tagObject");
                    expect(response.body.data.preview).toHaveProperty("passwordLayer");
                    found = true;
                }
            }
            expect(found).toBe(true);
        });

        it("GET /zelf-ids/search — finds the same name by tonAddress and xlmAddress", async () => {
            expect(publicData.tonAddress).toBeTruthy();
            expect(publicData.xlmAddress).toBeTruthy();

            const searchByAddress = async (key, value) => {
                let last;
                for (let attempt = 0; attempt < 8; attempt += 1) {
                    last = await request(API_BASE_URL)
                        .get(`${ZELF_IDS_PATH}/search`)
                        .set("Origin", ORIGIN)
                        .set("Authorization", `Bearer ${authToken}`)
                        .query({ domain: TEST_DOMAIN, os: "DESKTOP", key, value });

                    if (last.status === 200 && last.body.data?.tagObject?.publicData) {
                        return last.body.data;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                }
                return last?.body?.data;
            };

            const byTon = await searchByAddress("tonAddress", publicData.tonAddress);
            expect(byTon.available).toBe(false);
            expect(byTon.tagObject.publicData.tagName || byTon.tagName).toContain(tagName);
            expect(Number(byTon.tagObject.publicData.v)).toBe(4);

            const byXlm = await searchByAddress("xlmAddress", publicData.xlmAddress);
            expect(byXlm.available).toBe(false);
            expect(byXlm.tagObject.publicData.tagName || byXlm.tagName).toContain(tagName);
        });

        it("GET /zelf-ids/search — name search ignores continuation pins", async () => {
            const nameSearch = await request(API_BASE_URL)
                .get(`${ZELF_IDS_PATH}/search`)
                .set("Origin", ORIGIN)
                .set("Authorization", `Bearer ${authToken}`)
                .query({ tagName, domain: TEST_DOMAIN, os: "DESKTOP" });

            expect(nameSearch.status).toBe(200);
            expect(nameSearch.body.data.available).toBe(false);
            expect(nameSearch.body.data.ipfs.length).toBe(1);
            expect(nameSearch.body.data.tagObject.publicData._tagName).toBeUndefined();
            expect(nameSearch.body.data.tagObject.publicData.__tagName).toBeUndefined();
            expect(String(nameSearch.body.data.tagObject.name || "")).not.toMatch(/^_/);

            const continuationName = await request(API_BASE_URL)
                .get(`${ZELF_IDS_PATH}/search`)
                .set("Origin", ORIGIN)
                .set("Authorization", `Bearer ${authToken}`)
                .query({ tagName: `_${tagName}`, domain: TEST_DOMAIN, os: "DESKTOP" });

            expect(continuationName.status).toBe(200);
            expect(continuationName.body.data.available).toBe(true);
        });

        it("POST /zelf-ids/decrypt — returns the mnemonic from the leased v4 proof", async () => {
            const decryptResponse = await request(API_BASE_URL)
                .post(`${ZELF_IDS_PATH}/decrypt`)
                .set("Origin", ORIGIN)
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    tagName,
                    domain: TEST_DOMAIN,
                    faceBase64,
                    password: TEST_PASSWORD,
                    os: "DESKTOP",
                    removePGP: true,
                });

            expect(decryptResponse.status).toBe(200);
            expect(decryptResponse.body.data).toHaveProperty("publicData");
            expect(decryptResponse.body.data).toHaveProperty("metadata");
            expect(decryptResponse.body.data.metadata).toHaveProperty("mnemonic");
        });

        it("POST /zelf-ids/lease-recovery — same leased proof hits v4 (used or re-leased)", async () => {
            const recoveryName = uniqueTagName();
            const response = await request(API_BASE_URL)
                .post(`${ZELF_IDS_PATH}/lease-recovery`)
                .set("Origin", ORIGIN)
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    zelfProof,
                    tagName: recoveryName,
                    domain: TEST_DOMAIN,
                    faceBase64,
                    password: TEST_PASSWORD,
                    os: "DESKTOP",
                    removePGP: true,
                });

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty("data");

            const usedMessage = response.body.data.message;
            if (typeof usedMessage === "string" && /being used by another tag/i.test(usedMessage)) {
                return;
            }

            const recoveredPublic = response.body.data.tagObject?.publicData;
            expect(recoveredPublic.origin).toBe("online");
            expect(Number(recoveredPublic.v)).toBe(4);

            const cleanup = await request(API_BASE_URL)
                .delete(`${ZELF_IDS_PATH}/delete`)
                .set("Origin", ORIGIN)
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    tagName: recoveryName,
                    domain: TEST_DOMAIN,
                    faceBase64,
                    password: TEST_PASSWORD,
                });
            expect(cleanup.status).toBe(200);
        });

        it("DELETE /zelf-ids/delete — removes the leased v4 ID", async () => {
            const deleteResponse = await request(API_BASE_URL)
                .delete(`${ZELF_IDS_PATH}/delete`)
                .set("Origin", ORIGIN)
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    tagName,
                    domain: TEST_DOMAIN,
                    faceBase64,
                    password: TEST_PASSWORD,
                });

            expect(deleteResponse.status).toBe(200);
            expect(deleteResponse.body).toHaveProperty("data");
        });
    });

    // ─── 4b. lease-recovery from a fresh live v4 proof ──────────────────
    describe("4b. Lease recovery from a fresh JWT v4 proof", () => {
        jest.setTimeout(180000);

        let recoveredName;

        it("encrypts a v4 proof then recovers it onto a new Zelf ID", async () => {
            recoveredName = uniqueTagName();

            const encryptResponse = await request(API_BASE_URL)
                .post(`${JWT_HUMAN_AUTHN}/encrypt`)
                .set("Origin", ORIGIN)
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    faceBase64,
                    publicData: { source: "zelf-ids-recovery" },
                    metadata: { mnemonic: RECOVERY_MNEMONIC },
                    identifier: `zid_rec_${Date.now()}`,
                    os: "DESKTOP",
                    livenessLevel: "REGULAR",
                    requireLiveness: false,
                    password: TEST_PASSWORD,
                });

            expect(encryptResponse.status).toBe(200);
            expect(typeof encryptResponse.body.zelfID).toBe("string");

            const recoveryResponse = await request(API_BASE_URL)
                .post(`${ZELF_IDS_PATH}/lease-recovery`)
                .set("Origin", ORIGIN)
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    zelfProof: encryptResponse.body.zelfID,
                    tagName: recoveredName,
                    domain: TEST_DOMAIN,
                    faceBase64,
                    password: TEST_PASSWORD,
                    os: "DESKTOP",
                    removePGP: true,
                });

            expect(recoveryResponse.status).toBe(200);
            expect(recoveryResponse.body.data).toHaveProperty("tagObject");
            const recoveredPublic = recoveryResponse.body.data.tagObject.publicData;
            expect(recoveredPublic.origin).toBe("online");
            expect(Number(recoveredPublic.v)).toBe(4);
        });

        afterAll(async () => {
            if (!recoveredName || !authToken) return;
            await request(API_BASE_URL)
                .delete(`${ZELF_IDS_PATH}/delete`)
                .set("Origin", ORIGIN)
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    tagName: recoveredName,
                    domain: TEST_DOMAIN,
                    faceBase64,
                    password: TEST_PASSWORD,
                });
        });
    });

    // ─── 5. Lease offline on /api/zelf-ids ──────────────────────────────
    describe("5. Lease Offline on /api/zelf-ids", () => {
        jest.setTimeout(180000);

        let offlineName;

        it("POST /zelf-ids/lease-offline — 409 without tagName or proof", async () => {
            const missingName = await request(API_BASE_URL)
                .post(`${ZELF_IDS_PATH}/lease-offline`)
                .set("Origin", ORIGIN)
                .set("Authorization", `Bearer ${authToken}`)
                .send({});

            expect(missingName.status).toBe(409);
            expect(missingName.body).toHaveProperty("validationError");

            const missingProof = await request(API_BASE_URL)
                .post(`${ZELF_IDS_PATH}/lease-offline`)
                .set("Origin", ORIGIN)
                .set("Authorization", `Bearer ${authToken}`)
                .send({ tagName: uniqueTagName(), domain: TEST_DOMAIN });

            expect(missingProof.status).toBe(409);
            expect(missingProof.body).toHaveProperty("validationError");
        });

        it("POST /zelf-ids/lease-offline — leases a v4 proof as zelfIDObject", async () => {
            offlineName = uniqueTagName();

            const encryptResponse = await request(API_BASE_URL)
                .post(`${JWT_HUMAN_AUTHN}/encrypt`)
                .set("Origin", ORIGIN)
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    faceBase64,
                    publicData: {
                        tagName: `${offlineName}.${TEST_DOMAIN}`,
                        domain: TEST_DOMAIN,
                    },
                    metadata: { mnemonic: RECOVERY_MNEMONIC },
                    identifier: `zid_off_${Date.now()}`,
                    os: "DESKTOP",
                    livenessLevel: "REGULAR",
                    requireLiveness: false,
                    password: TEST_PASSWORD,
                });

            expect(encryptResponse.status).toBe(200);
            expect(typeof encryptResponse.body.zelfID).toBe("string");

            const offlineResponse = await request(API_BASE_URL)
                .post(`${ZELF_IDS_PATH}/lease-offline`)
                .set("Origin", ORIGIN)
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    tagName: offlineName,
                    domain: TEST_DOMAIN,
                    zelfProof: encryptResponse.body.zelfID,
                });

            expect(offlineResponse.status).toBe(200);
            expect(offlineResponse.body.data).toHaveProperty("zelfIDObject");
            const publicData = offlineResponse.body.data.zelfIDObject.publicData || {};
            expect(publicData.origin).toBe("offline");
            expect(Number(publicData.v)).toBe(4);
            expect(publicData.plan).toBe("free");
            expect(offlineResponse.body.data.walrus).toBeFalsy();
        });

        afterAll(async () => {
            if (!offlineName || !authToken) return;
            await request(API_BASE_URL)
                .delete(`${ZELF_IDS_PATH}/delete`)
                .set("Origin", ORIGIN)
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    tagName: offlineName,
                    domain: TEST_DOMAIN,
                    faceBase64,
                    password: TEST_PASSWORD,
                    removePGP: true,
                });
        });
    });

    // ─── 6. Validation & Error Handling ─────────────────────────────────
    describe("6. Validation & Error Handling", () => {
        it("POST /zelf-ids/lease — should return 409 when tagName is missing", async () => {
            const response = await request(API_BASE_URL)
                .post(`${ZELF_IDS_PATH}/lease`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    domain: TEST_DOMAIN,
                    faceBase64,
                    password: TEST_PASSWORD,
                    type: "create",
                    os: "DESKTOP",
                });

            expect(response.status).toBe(409);
            expect(response.body).toHaveProperty("validationError");
        });

        it("POST /zelf-ids/preview-zelf-id-qr — should return 409 when zelfProofQRCode is missing", async () => {
            const response = await request(API_BASE_URL)
                .post(`${ZELF_IDS_PATH}/preview-zelf-id-qr`)
                .set("Origin", ORIGIN)
                .set("Authorization", `Bearer ${authToken}`)
                .send({ os: "DESKTOP" });

            expect(response.status).toBe(409);
            expect(response.body).toHaveProperty("validationError");
        });

        it("POST /zelf-ids/preview-zelfproof — should return 409 when zelfProof is missing", async () => {
            const response = await request(API_BASE_URL)
                .post(`${ZELF_IDS_PATH}/preview-zelfproof`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    os: "DESKTOP",
                });

            expect(response.status).toBe(409);
            expect(response.body).toHaveProperty("validationError");
        });

        it("POST /zelf-ids/decrypt — should return 409 when faceBase64 is missing", async () => {
            const response = await request(API_BASE_URL)
                .post(`${ZELF_IDS_PATH}/decrypt`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    tagName: "test",
                    domain: TEST_DOMAIN,
                    password: TEST_PASSWORD,
                });

            expect(response.status).toBe(409);
            expect(response.body).toHaveProperty("validationError");
        });

        it("POST /zelf-ids/decrypt — should return 401 without auth", async () => {
            const response = await request(API_BASE_URL)
                .post(`${ZELF_IDS_PATH}/decrypt`)
                .set("Origin", "https://test.example.com")
                .send({
                    tagName: "test",
                    domain: TEST_DOMAIN,
                    faceBase64,
                    password: TEST_PASSWORD,
                });

            expect(response.status).toBe(401);
        });

        it("DELETE /zelf-ids/delete — should fail when tagName is missing", async () => {
            const response = await request(API_BASE_URL)
                .delete(`${ZELF_IDS_PATH}/delete`)
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    domain: TEST_DOMAIN,
                    faceBase64,
                    password: TEST_PASSWORD,
                });

            // The delete middleware validates tagName — could return 409 or 500
            expect([409, 500]).toContain(response.status);
        });
    });

    // ─── 7. Shared index: /zelf-ids vs /tags (not crypto-identical) ─────
    describe("7. Shared lookup with /tags", () => {
        it("search should return the same availability and name on both paths", async () => {
            const query = { tagName: "migueltrevino", domain: "zelf", os: "DESKTOP" };

            const [zelfIdsRes, tagsRes] = await Promise.all([
                request(API_BASE_URL)
                    .get(`${ZELF_IDS_PATH}/search`)
                    .set("Origin", "https://test.example.com")
                    .set("Authorization", `Bearer ${authToken}`)
                    .query(query),
                request(API_BASE_URL)
                    .get("/api/tags/search")
                    .set("Origin", "https://test.example.com")
                    .set("Authorization", `Bearer ${authToken}`)
                    .query(query),
            ]);

            expect(zelfIdsRes.status).toBe(tagsRes.status);
            expect(zelfIdsRes.body.data.available).toBe(tagsRes.body.data.available);
            expect(zelfIdsRes.body.data.tagName).toBe(tagsRes.body.data.tagName);
        });

        it("preview availability should match /tags for the same name", async () => {
            const query = { tagName: "migueltrevino", domain: "zelf", os: "DESKTOP" };

            const [zelfIdsRes, tagsRes] = await Promise.all([
                request(API_BASE_URL)
                    .get(`${ZELF_IDS_PATH}/preview`)
                    .set("Origin", "https://test.example.com")
                    .set("Authorization", `Bearer ${authToken}`)
                    .query(query),
                request(API_BASE_URL)
                    .get("/api/tags/preview")
                    .set("Origin", "https://test.example.com")
                    .set("Authorization", `Bearer ${authToken}`)
                    .query(query),
            ]);

            expect(zelfIdsRes.status).toBe(tagsRes.status);
            expect(zelfIdsRes.body.data.available).toBe(tagsRes.body.data.available);
        });

        it("domains should return identical results on both paths", async () => {
            const [zelfIdsRes, tagsRes] = await Promise.all([
                request(API_BASE_URL)
                    .get(`${ZELF_IDS_PATH}/domains`)
                    .set("Origin", "https://test.example.com")
                    .set("Authorization", `Bearer ${authToken}`),
                request(API_BASE_URL)
                    .get("/api/tags/domains")
                    .set("Origin", "https://test.example.com")
                    .set("Authorization", `Bearer ${authToken}`),
            ]);

            expect(zelfIdsRes.status).toBe(tagsRes.status);
            expect(JSON.stringify(zelfIdsRes.body)).toBe(JSON.stringify(tagsRes.body));
        });
    });

    // ─── 8. Search by domain ────────────────────────────────────────────
    describe("8. GET /zelf-ids/search-by-domain", () => {
        it("returns IPFS results for domain=zelf", async () => {
            const response = await request(API_BASE_URL)
                .get(`${ZELF_IDS_PATH}/search-by-domain`)
                .set("Origin", ORIGIN)
                .set("Authorization", `Bearer ${authToken}`)
                .query({ domain: TEST_DOMAIN, storage: "IPFS" });

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty("data");
            expect(Array.isArray(response.body.data)).toBe(true);
        });

        it("returns 409 when domain or storage is missing", async () => {
            const response = await request(API_BASE_URL)
                .get(`${ZELF_IDS_PATH}/search-by-domain`)
                .set("Origin", ORIGIN)
                .set("Authorization", `Bearer ${authToken}`)
                .query({ domain: TEST_DOMAIN });

            expect(response.status).toBe(409);
            expect(response.body).toHaveProperty("validationError");
        });

        it("returns 401 without auth", async () => {
            const response = await request(API_BASE_URL)
                .get(`${ZELF_IDS_PATH}/search-by-domain`)
                .set("Origin", ORIGIN)
                .query({ domain: TEST_DOMAIN, storage: "IPFS" });

            expect(response.status).toBe(401);
        });
    });

    // ─── 9. Wallet balances ─────────────────────────────────────────────
    describe("9. GET /zelf-ids/wallet-balances", () => {
        it("returns 409 when no addresses are provided", async () => {
            const response = await request(API_BASE_URL)
                .get(`${ZELF_IDS_PATH}/wallet-balances`)
                .set("Origin", ORIGIN)
                .set("Authorization", `Bearer ${authToken}`);

            expect(response.status).toBe(409);
            expect(response.body).toHaveProperty("validationError");
        });

        it("returns live balances for a real ETH address", async () => {
            const response = await request(API_BASE_URL)
                .get(`${ZELF_IDS_PATH}/wallet-balances`)
                .set("Origin", ORIGIN)
                .set("Authorization", `Bearer ${authToken}`)
                .query({ ethAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" });

            expect(response.status).toBe(200);
            expect(response.body.data).toHaveProperty("eth");
            expect(response.body.data).toHaveProperty("btc");
            expect(response.body.data).toHaveProperty("sol");
            expect(response.body.data).toHaveProperty("avax");
            expect(response.body.data).toHaveProperty("bdag");
            expect(response.body.data.eth).toHaveProperty("unit", "ETH");
            expect(response.body.data.eth).toHaveProperty("value");
        });
    });

    // ─── 10. Rewards / RevenueCat (real routes, no writes) ──────────────
    describe("10. Rewards routes", () => {
        it("POST /zelf-ids/revenue-cat — 409 without event", async () => {
            const response = await request(API_BASE_URL)
                .post(`${ZELF_IDS_PATH}/revenue-cat`)
                .set("Origin", ORIGIN)
                .set("Authorization", `Bearer ${authToken}`)
                .send({});

            expect(response.status).toBe(409);
            expect(response.body).toHaveProperty("validationError");
        });

        it("POST /zelf-ids/purchase-rewards — session JWT is not super-admin (403)", async () => {
            const response = await request(API_BASE_URL)
                .post(`${ZELF_IDS_PATH}/purchase-rewards`)
                .set("Origin", ORIGIN)
                .set("Authorization", `Bearer ${authToken}`)
                .send({});

            expect(response.status).toBe(403);
        });

        it("POST /zelf-ids/referral-rewards — session JWT is not super-admin (403)", async () => {
            const response = await request(API_BASE_URL)
                .post(`${ZELF_IDS_PATH}/referral-rewards`)
                .set("Origin", ORIGIN)
                .set("Authorization", `Bearer ${authToken}`)
                .send({});

            expect(response.status).toBe(403);
        });
    });

    // ─── 11. Plan categories (5h reserve, yearly dates, no Walrus) ─────
    describe("11. Plan categories", () => {
        jest.setTimeout(180000);

        let reservedName;
        let reservedPublicData;

        it("POST /zelf-ids/lease — long name is free mainnet, never .hold", async () => {
            const longName = uniqueTagName();

            const leaseResponse = await request(API_BASE_URL)
                .post(`${ZELF_IDS_PATH}/lease`)
                .set("Origin", ORIGIN)
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    tagName: longName,
                    domain: TEST_DOMAIN,
                    faceBase64,
                    password: TEST_PASSWORD,
                    type: "create",
                    os: "DESKTOP",
                    removePGP: true,
                });

            expect(leaseResponse.status).toBe(200);
            expect(leaseResponse.body.data.tagObject.publicData.type).toBe("mainnet");
            expect(leaseResponse.body.data.tagObject.publicData.plan).toBe("free");
            expect(leaseResponse.body.data.walrus).toBeFalsy();

            const yearsUntilExpiry = moment(leaseResponse.body.data.tagObject.publicData.expiresAt).diff(moment(), "year", true);
            expect(yearsUntilExpiry).toBeGreaterThanOrEqual(99);

            await request(API_BASE_URL)
                .delete(`${ZELF_IDS_PATH}/delete`)
                .set("Origin", ORIGIN)
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    tagName: longName,
                    domain: TEST_DOMAIN,
                    faceBase64,
                    password: TEST_PASSWORD,
                });
        });

        it("POST /zelf-ids/lease — short paid name is a one-year .zelf.hold reservation", async () => {
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

            reservedPublicData = leaseResponse.body.data.tagObject.publicData;
            expect(reservedPublicData.type).toBe("hold");
            expect(leaseResponse.body.data.walrus).toBeFalsy();

            const expiresAt = moment(reservedPublicData.expiresAt);
            const yearsUntilExpiry = expiresAt.diff(moment(), "year", true);
            expect(yearsUntilExpiry).toBeGreaterThanOrEqual(0.99);
            expect(yearsUntilExpiry).toBeLessThan(1.1);
        });

        it("GET /zelf-ids/search — unexpired reservation is not available", async () => {
            const response = await request(API_BASE_URL)
                .get(`${ZELF_IDS_PATH}/search`)
                .set("Origin", ORIGIN)
                .set("Authorization", `Bearer ${authToken}`)
                .query({ tagName: reservedName, domain: TEST_DOMAIN, os: "DESKTOP" });

            expect(response.status).toBe(200);
            expect(response.body.data.available).toBe(false);
            expect(response.body.data.tagObject.publicData.type).toBe("hold");
        });

        it("POST /zelf-ids/lease — duplicate unexpired reservation is 409", async () => {
            const response = await request(API_BASE_URL)
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

            expect(response.status).toBe(409);
            expect(`${response.body.code || ""} ${response.body.message || ""}`).toMatch(/Conflict|tag_already_exists|already exists/i);
        });

        it("GET /zelf-ids/payment-options — 409 without tagName/duration", async () => {
            const response = await request(API_BASE_URL)
                .get(`${ZELF_IDS_PATH}/payment-options`)
                .set("Origin", ORIGIN)
                .set("Authorization", `Bearer ${authToken}`);

            expect(response.status).toBe(409);
            expect(response.body).toHaveProperty("validationError");
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

        it("GET /zelf-ids/payment-options — reserved name returns unique addresses and a JWT", async () => {
            const response = await request(API_BASE_URL)
                .get(`${ZELF_IDS_PATH}/payment-options`)
                .set("Origin", ORIGIN)
                .set("Authorization", `Bearer ${authToken}`)
                .query({ tagName: reservedName, domain: TEST_DOMAIN, duration: "1" });

            expect(response.status).toBe(200);
            expect(response.body.data.tagName).toBe(`${reservedName}.${TEST_DOMAIN}`);
            expect(response.body.data.tagPayName).toBe(`${reservedName}.${TEST_DOMAIN}pay`);
            expect(response.body.data.paymentAddress.solanaAddress).toBeTruthy();
            expect(response.body.data.paymentAddress.btcAddress).toBeTruthy();
            expect(typeof response.body.data.signedDataPrice).toBe("string");
            expect(response.body.data.duration).toBe(1);
        });
    });
});
