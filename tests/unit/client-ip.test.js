jest.mock("../../Repositories/RPCCaller/models/rpc-caller.model", () => ({
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
}));

jest.mock("../../Repositories/RPCCaller/models/rpc-caller-window.model", () => ({
    findOneAndUpdate: jest.fn(),
    aggregate: jest.fn(),
}));

jest.mock("../../Repositories/RPC/modules/rpc.module", () => ({
    forwardRequest: jest.fn(async () => ({
        result: "0x1",
        chain: "ethereum",
        chainId: 1,
        method: "eth_chainId",
        upstreamId: 1,
    })),
    getChains: jest.fn(() => []),
    getExtensionChains: jest.fn(() => []),
}));

jest.mock("../../Repositories/RPC/modules/rpc-rest.module", () => ({
    proxyBitcoin: jest.fn(async () => ({ status: 200, body: [], contentType: "application/json" })),
    proxyStellar: jest.fn(async () => ({ status: 200, body: {}, contentType: "application/json" })),
}));

const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const Koa = require("koa");
const { koaBody } = require("koa-body");
const koaJwt = require("koa-jwt");
const Router = require("@koa/router");
const request = require("supertest");
const config = require("../../Core/config");
const RpcCallerWindow = require("../../Repositories/RPCCaller/models/rpc-caller-window.model");
const { assertWithinRateLimit } = require("../../Repositories/RPCCaller/modules/rpc-caller.module");
const { forwardRequest } = require("../../Repositories/RPC/modules/rpc.module");

const secret = config.JWT_SECRET || "test-jwt-secret-key-for-testing-only";
if (!config.JWT_SECRET) config.JWT_SECRET = secret;

describe("trusted client IP", () => {
    beforeEach(() => {
        RpcCallerWindow.findOneAndUpdate.mockReset();
        RpcCallerWindow.aggregate.mockReset();
        RpcCallerWindow.findOneAndUpdate.mockReturnValue({
            lean: async () => ({ count: 1 }),
        });
        RpcCallerWindow.aggregate.mockResolvedValue([{ total: 1 }]);
        forwardRequest.mockClear();
    });

    it("configures the API for one proxy hop", () => {
        const source = fs.readFileSync(path.resolve(__dirname, "../../server.js"), "utf8");
        expect(source).toMatch(/app\.proxy\s*=\s*true/);
        expect(source).toMatch(/app\.maxIpsCount\s*=\s*1/);
    });

    it("keys the existing per-IP limiter on the proxy-appended address", async () => {
        const seen = [];
        const app = new Koa();
        app.proxy = true;
        app.maxIpsCount = 1;
        app.use(async (ctx) => {
            seen.push(ctx.ip);
            await assertWithinRateLimit(ctx.ip);
            ctx.body = { ok: true };
        });

        const spoofed = await request(app.callback()).get("/limited").set("X-Forwarded-For", "198.51.100.1, 203.0.113.77");
        expect(spoofed.status).toBe(200);
        expect(seen).toEqual(["203.0.113.77"]);
        expect(RpcCallerWindow.findOneAndUpdate.mock.calls[0][0].ip).toBe("203.0.113.77");

        RpcCallerWindow.findOneAndUpdate.mockClear();
        const single = await request(app.callback()).get("/limited").set("X-Forwarded-For", "203.0.113.50");
        expect(single.status).toBe(200);
        expect(RpcCallerWindow.findOneAndUpdate.mock.calls[0][0].ip).toBe("203.0.113.50");
    });

    it("passes that address into the RPC proxy rate-limit key", async () => {
        const app = new Koa();
        app.proxy = true;
        app.maxIpsCount = 1;
        app.use(koaBody({ jsonLimit: "1mb" }));
        app.use(koaJwt({ secret: config.JWT_SECRET }));
        const router = new Router();
        require("../../Repositories/RPC/routes/protected-rpc.routes")(router);
        app.use(router.routes());

        const token = jwt.sign({ identifier: "device-1" }, config.JWT_SECRET);
        const previous = config.extension.rpc.allowedRequestOrigins;
        config.extension.rpc.allowedRequestOrigins = [];
        try {
            const res = await request(app.callback())
                .post("/api/protected/rpc/ethereum")
                .set("Authorization", `Bearer ${token}`)
                .set("X-Forwarded-For", "198.51.100.1, 203.0.113.77")
                .send({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });

            expect(res.status).toBe(200);
            expect(forwardRequest).toHaveBeenCalledWith(
                expect.objectContaining({ chain: "ethereum", method: "eth_chainId" }),
                expect.objectContaining({ ip: "203.0.113.77" }),
                { useExtensionRpc: true }
            );
        } finally {
            config.extension.rpc.allowedRequestOrigins = previous;
        }
    });
});
