const crypto = require("crypto");
const request = require("supertest");
require("dotenv").config();

process.env.FACE_POW_HMAC_SECRET = process.env.FACE_POW_HMAC_SECRET || crypto.randomBytes(32).toString("hex");

const API_BASE_URL = `http://localhost:${process.env.PORT || 3000}`;

describe("Face security API", () => {
    let authToken;

    beforeAll(async () => {
        const sessionResponse = await request(API_BASE_URL)
            .post("/api/sessions")
            .set("Origin", "https://test.example.com")
            .send({
                identifier: `face_sec_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                type: "general",
                isWebExtension: true,
            });

        expect(sessionResponse.status).toBe(200);
        authToken = sessionResponse.body.data.token;
    });

    it("POST /api/face/nonce issues nonce for an action/identifier", async () => {
        const response = await request(API_BASE_URL)
            .post("/api/face/nonce")
            .set("Authorization", `Bearer ${authToken}`)
            .set("Origin", "https://test.example.com")
            .send({ action: "decrypt", identifier: "integration-test@zelf" });

        expect(response.status).toBe(200);
        expect(response.body.data).toHaveProperty("nonce");
        expect(response.body.data).toHaveProperty("expiresAt");
    });
});
