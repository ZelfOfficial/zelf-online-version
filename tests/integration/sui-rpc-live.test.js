/**
 * RPC proxy: POST /api/rpc/sui — JSON-RPC body, answered from Sui GraphQL (no JWT).
 * Prerequisites: API running (e.g. PORT=3003 npm start), MongoDB, Sui GraphQL reachable
 * (`${SUI_RPC_URL}/graphql` or the public mainnet endpoint).
 */
const path = require("path");
const request = require("supertest");

require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: false });

const apiBaseUrl = () =>
    process.env.API_INTEGRATION_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3003}`;

describe("Sui RPC (live server, no JWT)", () => {
    it("POST /api/rpc/sui proxies sui_getChainIdentifier (JSON-RPC body)", async () => {
        const res = await request(apiBaseUrl())
            .post("/api/rpc/sui")
            .set("Origin", "https://test.example.com")
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
