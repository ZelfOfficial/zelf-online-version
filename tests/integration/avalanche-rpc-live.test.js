/**
 * RPC proxy requires a session JWT.
 * Prerequisites: API running (e.g. PORT=3003 npm start), MongoDB, Avalanche upstream in server env.
 */
const path = require("path");
const request = require("supertest");

require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: false });

const apiBaseUrl = () =>
    process.env.API_INTEGRATION_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3003}`;

const CHAIN_ID_MAINNET_HEX = "0xa86a"; // 43114

describe("Avalanche RPC (live server, session JWT)", () => {
    let token;

    beforeAll(async () => {
        const session = await request(apiBaseUrl())
            .post("/api/sessions")
            .set("Origin", "https://test.example.com")
            .send({
                identifier: `avalanche_rpc_${Date.now()}_${Math.random().toString(36).substring(7)}`,
                type: "general",
                isWebExtension: false,
            });
        expect(session.status).toBe(200);
        token = session.body.data.token;
    });

    it("POST /api/rpc/avalanche rejects missing JWT", async () => {
        const res = await request(apiBaseUrl())
            .post("/api/rpc/avalanche")
            .set("Origin", "https://test.example.com")
            .send({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });

        expect(res.status).toBe(401);
    });

    it("POST /api/rpc/request wraps eth_chainId (legacy envelope)", async () => {
        const res = await request(apiBaseUrl())
            .post("/api/rpc/request")
            .set("Origin", "https://test.example.com")
            .set("Authorization", `Bearer ${token}`)
            .send({
                chain: "avalanche",
                method: "eth_chainId",
                params: [],
            });

        expect(res.status).toBe(200);
        expect(res.body?.data).toBeDefined();
        expect(res.body.data.result).toBe(CHAIN_ID_MAINNET_HEX);
        expect(res.body.data.chain).toBe("avalanche");
    }, 45000);

    it("POST /api/rpc/avalanche accepts standard JSON-RPC body (drop-in URL replacement)", async () => {
        const res = await request(apiBaseUrl())
            .post("/api/rpc/avalanche")
            .set("Origin", "https://test.example.com")
            .set("Authorization", `Bearer ${token}`)
            .send({
                jsonrpc: "2.0",
                id: 1,
                method: "eth_chainId",
                params: [],
            });

        expect(res.status).toBe(200);
        expect(res.body.jsonrpc).toBe("2.0");
        expect(res.body.id).toBe(1);
        expect(res.body.result).toBe(CHAIN_ID_MAINNET_HEX);
        expect(res.body.error).toBeUndefined();
    }, 45000);
});
