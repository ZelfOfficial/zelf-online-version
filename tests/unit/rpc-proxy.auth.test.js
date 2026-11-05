jest.mock("../../Repositories/RPC/modules/rpc.module", () => ({
    forwardRequest: jest.fn(async () => ({
        result: "0x1",
        chain: "ethereum",
        chainId: 1,
        method: "eth_chainId",
        upstreamId: 1,
    })),
    getChains: jest.fn(() => []),
    getExtensionChains: jest.fn(() => [{ chain: "ethereum", chainId: 1, rpcConfigured: true }]),
}));

jest.mock("../../Repositories/RPC/modules/rpc-rest.module", () => ({
    proxyBitcoin: jest.fn(async () => ({ status: 200, body: [], contentType: "application/json" })),
    proxyStellar: jest.fn(async () => ({ status: 200, body: { fee_charged: { min: "100" } }, contentType: "application/json" })),
}));

const jwt = require("jsonwebtoken");
const Koa = require("koa");
const { koaBody } = require("koa-body");
const koaJwt = require("koa-jwt");
const Router = require("@koa/router");
const request = require("supertest");
const config = require("../../Core/config");
const { forwardRequest } = require("../../Repositories/RPC/modules/rpc.module");
const { proxyBitcoin, proxyStellar } = require("../../Repositories/RPC/modules/rpc-rest.module");
const { requireAllowedProtectedRpcOrigin } = require("../../Repositories/RPC/middlewares/protected-rpc-origin.middleware");

const secret = config.JWT_SECRET || "test-jwt-secret-key-for-testing-only";
if (!config.JWT_SECRET) config.JWT_SECRET = secret;

const buildApp = () => {
    const app = new Koa();
    app.use(koaBody({ jsonLimit: "1mb", textLimit: "1mb", includeUnparsed: true }));
    app.use(async (ctx, next) => {
        try {
            await next();
        } catch (err) {
            if (err.status === 401) {
                ctx.status = 401;
                ctx.body = { error: "Protected resource, use Authorization header to get access" };
                return;
            }
            throw err;
        }
    });
    app.use(
        koaJwt({
            secret: config.JWT_SECRET,
        }).unless(() => false)
    );
    const router = new Router();
    require("../../Repositories/RPC/routes/rpc.routes")(router);
    require("../../Repositories/RPC/routes/protected-rpc.routes")(router);
    app.use(router.routes());
    return app;
};

describe("RPC proxy auth", () => {
    const app = buildApp();
    const token = jwt.sign({ identifier: "device-1", session: "sess-1" }, config.JWT_SECRET);
    const previousOrigins = config.extension.rpc.allowedRequestOrigins;

    beforeAll(() => {
        config.extension.rpc.allowedRequestOrigins = [];
    });

    afterAll(() => {
        config.extension.rpc.allowedRequestOrigins = previousOrigins;
    });

    beforeEach(() => {
        forwardRequest.mockClear();
        proxyBitcoin.mockClear();
        proxyStellar.mockClear();
    });

    it("keeps the JSON-RPC routes off the unprotected registry", () => {
        const fs = require("fs");
        const path = require("path");
        const source = fs.readFileSync(path.resolve(__dirname, "../../Routes/unprotected-repositories.js"), "utf8");
        expect(source).not.toMatch(/rpc\.routes/);
    });

    it.each([
        ["/api/rpc/ethereum"],
        ["/api/protected/rpc/ethereum"],
        ["/api/protected/rpc/btc/mainnet/address/bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4/utxo"],
        ["/api/protected/rpc/stellar/fee_stats"],
    ])("requires a session JWT for %s", async (path) => {
        const res = await request(app.callback()).post(path).send({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
        if (path.includes("/utxo") || path.endsWith("/fee_stats")) {
            const getRes = await request(app.callback()).get(path);
            expect(getRes.status).toBe(401);
            return;
        }
        expect(res.status).toBe(401);
    });

    it("forwards an authenticated extension JSON-RPC call", async () => {
        const res = await request(app.callback())
            .post("/api/protected/rpc/ethereum")
            .set("Authorization", `Bearer ${token}`)
            .set("Origin", "https://test.example.com")
            .send({ jsonrpc: "2.0", id: 4, method: "eth_chainId", params: [] });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ jsonrpc: "2.0", id: 4, result: "0x1" });
        expect(forwardRequest).toHaveBeenCalledWith(
            expect.objectContaining({ chain: "ethereum", method: "eth_chainId" }),
            expect.objectContaining({ authUser: expect.objectContaining({ identifier: "device-1" }) }),
            { useExtensionRpc: true }
        );
    });

    it("forwards authenticated bitcoin and stellar reads", async () => {
        const btc = await request(app.callback())
            .get("/api/protected/rpc/btc/mainnet/address/bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4/utxo")
            .set("Authorization", `Bearer ${token}`);
        const stellar = await request(app.callback())
            .get("/api/protected/rpc/stellar/fee_stats")
            .set("Authorization", `Bearer ${token}`);

        expect(btc.status).toBe(200);
        expect(stellar.status).toBe(200);
        expect(proxyBitcoin).toHaveBeenCalled();
        expect(proxyStellar).toHaveBeenCalled();
    });

    it("rejects a protected RPC call from a disallowed Origin", async () => {
        const ctx = {
            get: (name) => (name === "origin" ? "https://evil.example" : ""),
            headers: { origin: "https://evil.example" },
            status: 200,
            body: null,
        };
        config.extension.rpc.allowedRequestOrigins = ["chrome-extension://extensionidexample"];
        const next = jest.fn();
        await requireAllowedProtectedRpcOrigin(ctx, next);
        expect(next).not.toHaveBeenCalled();
        expect(ctx.status).toBe(403);
        expect(ctx.body.error).toBe("forbidden_origin");
        config.extension.rpc.allowedRequestOrigins = [];
    });

    it("allows authenticated GET requests without an Origin header when allowedRequestOrigins is configured (Chrome MV3 host_permissions GET)", async () => {
        config.extension.rpc.allowedRequestOrigins = ["chrome-extension://extensionidexample"];
        try {
            const stellar = await request(app.callback())
                .get("/api/protected/rpc/stellar/fee_stats")
                .set("Authorization", `Bearer ${token}`);
            expect(stellar.status).toBe(200);

            const disallowedGet = await request(app.callback())
                .get("/api/protected/rpc/stellar/fee_stats")
                .set("Authorization", `Bearer ${token}`)
                .set("Origin", "https://evil.example");
            expect(disallowedGet.status).toBe(403);
        } finally {
            config.extension.rpc.allowedRequestOrigins = [];
        }
    });
});
