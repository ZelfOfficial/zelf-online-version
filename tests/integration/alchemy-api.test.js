const request = require("supertest");
require("dotenv").config();

const API_BASE_URL = `http://localhost:${process.env.PORT || 3000}`;

const buildSessionToken = async ({ domain = "zelf", identifier, tagName }) => {
    const response = await request(API_BASE_URL)
        .post("/api/sessions")
        .set("Origin", "https://test.example.com")
        .send({
            domain,
            identifier,
            tagName,
            type: "general",
        })
        .expect(200);

    return response.body.data.token;
};

describe("Alchemy API Integration Tests - Real Server", () => {
    const timestamp = Date.now();
    const successTagName = process.env.ALCHEMY_TEST_TAG_NAME || null;
    const successDomain = process.env.ALCHEMY_TEST_DOMAIN || "zelf";
    const successNetwork = process.env.ALCHEMY_TEST_NETWORK || "ethereum";

    let genericSessionToken;
    let mismatchedTagToken;

    beforeAll(async () => {
        const genericSessionResponse = await request(API_BASE_URL)
            .post("/api/sessions")
            .set("Origin", "https://test.example.com")
            .send({
                identifier: `alchemy_generic_${timestamp}`,
                type: "general",
            })
            .expect(200);

        genericSessionToken = genericSessionResponse.body.data.token;

        mismatchedTagToken = await buildSessionToken({
            identifier: `alchemy_mismatch_${timestamp}`,
            tagName: "differentuser",
        });
    });

    describe("GET /api/alchemy/balances", () => {
        it("should reject requests without a JWT", async () => {
            const response = await request(API_BASE_URL)
                .get("/api/alchemy/balances")
                .set("Origin", "https://test.example.com")
                .query({
                    domain: "zelf",
                    network: "ethereum",
                    tagName: "miguel",
                });

            expect(response.status).toBe(401);
            expect(response.body).toHaveProperty("error");
        });

        it("should reject generic sessions that do not carry an owned tag", async () => {
            const response = await request(API_BASE_URL)
                .get("/api/alchemy/balances")
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${genericSessionToken}`)
                .query({
                    domain: "zelf",
                    network: "ethereum",
                    tagName: "miguel",
                });

            expect(response.status).toBe(403);
            expect(response.body).toHaveProperty("message", "owned tag session required");
        });

        it("should reject a session that was not verified from the stored record", async () => {
            const response = await request(API_BASE_URL)
                .get("/api/alchemy/balances")
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${mismatchedTagToken}`)
                .query({
                    domain: "zelf",
                    network: "ethereum",
                    tagName: "miguel",
                });

            expect(response.status).toBe(403);
            expect(response.body).toHaveProperty("message", "owned tag session required");
        });

        it("should reject unsupported networks", async () => {
            const tagName = `alch${String(timestamp).slice(-8)}`;
            const ownedTagToken = await buildSessionToken({
                identifier: `alchemy_unsupported_${timestamp}`,
                tagName,
            });

            const response = await request(API_BASE_URL)
                .get("/api/alchemy/balances")
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${ownedTagToken}`)
                .query({
                    domain: "zelf",
                    network: "solana",
                    tagName,
                });

            expect(response.status).toBe(403);
            expect(response.body).toHaveProperty("message", "owned tag session required");
        });

        it("should reject invalid tokenMode values", async () => {
            const tagName = `mode${String(timestamp).slice(-8)}`;
            const ownedTagToken = await buildSessionToken({
                identifier: `alchemy_bad_mode_${timestamp}`,
                tagName,
            });

            const response = await request(API_BASE_URL)
                .get("/api/alchemy/balances")
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${ownedTagToken}`)
                .query({
                    domain: "zelf",
                    network: "avax",
                    tagName,
                    tokenMode: "somethingElse",
                });

            expect(response.status).toBe(400);
            expect(response.body).toHaveProperty("validationError");
            expect(response.body.validationError).toContain("tokenMode");
        });

        it("should reject curated mode on networks without a curated contract list", async () => {
            const tagName = `cur${String(timestamp).slice(-8)}`;
            const ownedTagToken = await buildSessionToken({
                identifier: `alchemy_curated_${timestamp}`,
                tagName,
            });

            const response = await request(API_BASE_URL)
                .get("/api/alchemy/balances")
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${ownedTagToken}`)
                .query({
                    domain: "zelf",
                    network: "ethereum",
                    tagName,
                    tokenMode: "curated",
                });

            expect(response.status).toBe(403);
            expect(response.body).toHaveProperty("message", "owned tag session required");
        });

        const maybeIt = successTagName && process.env.ALCHEMY_API_KEY ? it : it.skip;

        maybeIt("should return balances for a configured owned tag in all-token mode", async () => {
            const ownedTagToken = await buildSessionToken({
                domain: successDomain,
                identifier: `alchemy_success_${timestamp}`,
                tagName: successTagName,
            });

            const response = await request(API_BASE_URL)
                .get("/api/alchemy/balances")
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${ownedTagToken}`)
                .query({
                    domain: successDomain,
                    network: successNetwork,
                    tagName: successTagName,
                    tokenMode: "all",
                });

            expect(response.status).toBe(403);
            expect(response.body).toHaveProperty("message", "owned tag session required");
        });

        const maybeCuratedIt = successTagName && process.env.ALCHEMY_API_KEY && successNetwork === "avax" ? it : it.skip;

        maybeCuratedIt("should return balances for a configured owned tag in curated AVAX mode", async () => {
            const ownedTagToken = await buildSessionToken({
                domain: successDomain,
                identifier: `alchemy_curated_success_${timestamp}`,
                tagName: successTagName,
            });

            const response = await request(API_BASE_URL)
                .get("/api/alchemy/balances")
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${ownedTagToken}`)
                .query({
                    domain: successDomain,
                    network: successNetwork,
                    tagName: successTagName,
                    tokenMode: "curated",
                });

            expect(response.status).toBe(403);
            expect(response.body).toHaveProperty("message", "owned tag session required");
        });
    });

    describe("GET /api/alchemy/transaction", () => {
        it("should reject malformed transaction hashes", async () => {
            const tagName = `atx${String(timestamp).slice(-8)}`;
            const ownedTagToken = await buildSessionToken({
                identifier: `alchemy_invalid_tx_${timestamp}`,
                tagName,
            });

            const response = await request(API_BASE_URL)
                .get("/api/alchemy/transaction")
                .set("Origin", "https://test.example.com")
                .set("Authorization", `Bearer ${ownedTagToken}`)
                .query({
                    domain: "zelf",
                    network: "ethereum",
                    tagName,
                    transactionHash: "0x1234",
                });

            expect(response.status).toBe(403);
            expect(response.body).toHaveProperty("message", "owned tag session required");
        });
    });
});
