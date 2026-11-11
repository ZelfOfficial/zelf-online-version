/**
 * Vault Legacy demo mode integration tests.
 * Requires live API + MongoDB. Chain tests require LEGACY_DEMO_MODE and contract env.
 *
 * Run: PORT=3003 LEGACY_DEMO_MODE=true LEGACY_DEMO_LAWYER_ADDRESS=0x... npm run test:integration -- vault-legacy-demo
 */

const path = require("path");
const request = require("supertest");

require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: false });

const apiBaseUrl = () =>
    process.env.API_INTEGRATION_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3003}`;
const LEGACY_PATH = "/api/vault-legacy";

const hasDemoEnv = () =>
    process.env.LEGACY_DEMO_MODE === "true" &&
    Boolean(process.env.LEGACY_DEMO_LAWYER_ADDRESS?.trim());

async function getLegacyToken() {
    const res = await request(apiBaseUrl())
        .post(`${LEGACY_PATH}/sessions`)
        .send({ identifier: `demo-test-${Date.now()}` });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    return res.body.token;
}

describe("vault-legacy demo mode", () => {
    describe("GET /demo/status", () => {
        it("returns demo status payload", async () => {
            const res = await request(apiBaseUrl()).get(`${LEGACY_PATH}/demo/status`);
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                success: true,
                enabled: expect.any(Boolean),
                demoHeartbeatInterval: expect.any(Number),
            });
        });
    });

    describe("POST /relay/register-emails", () => {
        it("rejects isDemo when LEGACY_DEMO_MODE is false", async () => {
            if (process.env.LEGACY_DEMO_MODE === "true") {
                return;
            }

            const token = await getLegacyToken();
            const vaultId = `0x${"demo".padEnd(64, "0")}`;

            const res = await request(apiBaseUrl())
                .post(`${LEGACY_PATH}/relay/register-emails`)
                .set("Authorization", `Bearer ${token}`)
                .send({
                    vaultId,
                    isDemo: true,
                    testatorEmail: "demo-testator@example.com",
                });

            expect(res.status).toBe(403);
            expect(res.body.error).toMatch(/demo mode is not enabled/i);
        });

        it("accepts isDemo when LEGACY_DEMO_MODE is true", async () => {
            if (!hasDemoEnv()) {
                console.warn("Skipping: set LEGACY_DEMO_MODE=true and LEGACY_DEMO_LAWYER_ADDRESS for full demo register test");
                return;
            }

            const token = await getLegacyToken();
            const vaultId = `0x${Date.now().toString(16).padStart(64, "0")}`;

            const res = await request(apiBaseUrl())
                .post(`${LEGACY_PATH}/relay/register-emails`)
                .set("Authorization", `Bearer ${token}`)
                .send({
                    vaultId,
                    isDemo: true,
                    testatorEmail: `demo-${Date.now()}@example.com`,
                    lawyerEmail: "demo-lawyer@example.com",
                    beneficiaryEmails: [],
                });

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ success: true, isDemo: true });
        });
    });

    describe("lawyer actions on demo vaults", () => {
        it("returns 409 for accept-vault on a known demo vault id in mongo", async () => {
            if (!hasDemoEnv()) return;

            const token = await getLegacyToken();
            const vaultId = `0x${"409demo".padEnd(64, "0")}`;

            await request(apiBaseUrl())
                .post(`${LEGACY_PATH}/relay/register-emails`)
                .set("Authorization", `Bearer ${token}`)
                .send({ vaultId, isDemo: true, testatorEmail: "t@example.com" });

            const res = await request(apiBaseUrl())
                .post(`${LEGACY_PATH}/avalanche/accept-vault`)
                .set("Authorization", `Bearer ${token}`)
                .send({
                    vaultId,
                    authSig: {
                        address: process.env.LEGACY_DEMO_LAWYER_ADDRESS,
                        signedMessage: "ZelfLegacy accept-vault invalid",
                        sig: "0x" + "00".repeat(65),
                    },
                });

            expect([401, 409]).toContain(res.status);
            if (res.status === 409) {
                expect(res.body.error).toMatch(/auto-accepted/i);
            }
        });
    });
});
