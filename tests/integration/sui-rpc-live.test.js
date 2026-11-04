/**
 * RPC proxy: POST /api/rpc/sui — JSON-RPC body, answered from Sui GraphQL.
 * Requires a session JWT. Prerequisites: API running (e.g. PORT=3003 npm start), MongoDB,
 * Sui GraphQL reachable (`${SUI_RPC_URL}/graphql` or the public mainnet endpoint).
 */
const path = require("path");
const request = require("supertest");

require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: false });

const apiBaseUrl = () =>
    process.env.API_INTEGRATION_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3003}`;

describe("Sui RPC (live server, session JWT)", () => {
    let token;

    beforeAll(async () => {
        const session = await request(apiBaseUrl())
            .post("/api/sessions")
            .set("Origin", "https://test.example.com")
            .send({
                identifier: `sui_rpc_${Date.now()}_${Math.random().toString(36).substring(7)}`,
                type: "general",
                isWebExtension: false,
            });
        expect(session.status).toBe(200);
        token = session.body.data.token;
    });

    it("POST /api/rpc/sui rejects missing JWT", async () => {
        const res = await request(apiBaseUrl())
            .post("/api/rpc/sui")
            .set("Origin", "https://test.example.com")
            .send({ jsonrpc: "2.0", id: 1, method: "sui_getChainIdentifier", params: [] });

        expect(res.status).toBe(401);
    });

    it("POST /api/rpc/sui proxies sui_getChainIdentifier (JSON-RPC body)", async () => {
        const res = await request(apiBaseUrl())
            .post("/api/rpc/sui")
            .set("Origin", "https://test.example.com")
            .set("Authorization", `Bearer ${token}`)
            .send({
                jsonrpc: "2.0",
                id: 1,
                method: "sui_getChainIdentifier",
                params: [],
            });

        expect(res.status).toBe(200);
        expect(res.body.jsonrpc).toBe("2.0");
        expect(res.body.id).toBe(1);
        expect(res.body.error).toBeUndefined();
        expect(typeof res.body.result).toBe("string");
        expect(res.body.result.length).toBeGreaterThan(0);
    }, 45000);
});
