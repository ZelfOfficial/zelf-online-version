jest.mock("../../Repositories/RPC/modules/rpc.module", () => ({
    forwardRequest: jest.fn(async () => ({
        result: "0x1",
        chain: "ethereum",
        chainId: 1,
        method: "eth_chainId",
        upstreamId: 1,
    })),
    forwardSessionlessCall: jest.fn(async () => ({
        result: "0x1",
        chain: "ethereum",
        method: "eth_chainId",
        upstreamId: 1,
    })),
    getChains: jest.fn(() => []),
    getExtensionChains: jest.fn(() => [{ chain: "ethereum", chainId: 1, rpcConfigured: true }]),
}));

jest.mock("../../Repositories/RPC/modules/rpc-rest.module", () => ({
    proxyBitcoin: jest.fn(async () => ({ status: 200, body: [], contentType: "application/json" })),
    proxyStellar: jest.fn(async () => ({ status: 200, body: {}, contentType: "application/json" })),
}));

jest.mock("../../Repositories/RPCCaller/modules/rpc-caller.module", () => ({
    assertNotBanned: jest.fn(async () => {}),
    assertWithinRateLimit: jest.fn(async () => {}),
    assertWithinSessionlessRateLimit: jest.fn(async () => {}),
    recordRequest: jest.fn(),
}));

const jwt = require("jsonwebtoken");
const Koa = require("koa");
const { koaBody } = require("koa-body");
const koaJwt = require("koa-jwt");
const Router = require("@koa/router");
const request = require("supertest");
const config = require("../../Core/config");
const { forwardRequest, forwardSessionlessCall } = require("../../Repositories/RPC/modules/rpc.module");
const RpcCaller = require("../../Repositories/RPCCaller/modules/rpc-caller.module");
const { isSessionlessLaneActive } = require("../../Repositories/RPC/modules/sessionless-lane.module");

const secret = config.JWT_SECRET || "test-jwt-secret-key-for-testing-only";
if (!config.JWT_SECRET) config.JWT_SECRET = secret;

const LANE_ENV = ["RPC_ALLOW_SESSIONLESS_APPS", "RPC_SESSIONLESS_SUNSET", "RPC_SESSIONLESS_GETLOGS_MAX_BLOCKS"];

const chainIdBody = { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] };

const buildApp = () => {
    const app = new Koa();
    app.proxy = true;
    app.maxIpsCount = 1;
    app.use(koaBody({ jsonLimit: "1mb" }));
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

    const open = new Router();
    require("../../Repositories/RPC/routes/sessionless-rpc.routes")(open);
    app.use(open.routes());
    app.use(koaJwt({ secret: config.JWT_SECRET }));

    const locked = new Router();
    require("../../Repositories/RPC/routes/rpc.routes")(locked);
    require("../../Repositories/RPC/routes/protected-rpc.routes")(locked);
    app.use(locked.routes());
    return app;
};

describe("sessionless RPC compatibility lane", () => {
    const app = buildApp();
    const token = jwt.sign({ identifier: "device-1", session: "sess-1" }, config.JWT_SECRET);
    const saved = {};
    let infoSpy;

    beforeAll(() => {
        for (const key of LANE_ENV) saved[key] = process.env[key];
    });

    afterAll(() => {
        for (const key of LANE_ENV) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    });

    beforeEach(() => {
        for (const key of LANE_ENV) delete process.env[key];
        forwardRequest.mockClear();
        forwardSessionlessCall.mockClear();
        RpcCaller.assertNotBanned.mockClear();
        RpcCaller.assertWithinSessionlessRateLimit.mockClear();
        RpcCaller.recordRequest.mockClear();
        infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
    });

    afterEach(() => {
        infoSpy.mockRestore();
        config.extension.rpc.allowedRequestOrigins = [];
    });

    const postChain = (chain, body, { origin, authorization, forwarded } = {}) => {
        const req = request(app.callback()).post(`/api/rpc/${chain}`).send(body || chainIdBody);
        if (origin) req.set("Origin", origin);
        if (authorization) req.set("Authorization", authorization);
        if (forwarded) req.set("X-Forwarded-For", forwarded);
        return req;
    };

    it("treats the lane as off unless the flag is true and the sunset has not passed", () => {
        const env = { RPC_ALLOW_SESSIONLESS_APPS: "true", RPC_SESSIONLESS_SUNSET: "2027-01-31" };
        expect(isSessionlessLaneActive(env, new Date("2027-01-31T23:00:00.000Z"))).toBe(true);
        expect(isSessionlessLaneActive(env, new Date("2027-02-01T00:00:00.000Z"))).toBe(false);
        expect(isSessionlessLaneActive({ RPC_ALLOW_SESSIONLESS_APPS: "true" }, new Date("2030-01-01T00:00:00.000Z"))).toBe(true);
        expect(isSessionlessLaneActive({ RPC_ALLOW_SESSIONLESS_APPS: "false" }, new Date("2026-01-01T00:00:00.000Z"))).toBe(false);
        expect(isSessionlessLaneActive({ RPC_ALLOW_SESSIONLESS_APPS: "true", RPC_SESSIONLESS_SUNSET: "not-a-date" }, new Date())).toBe(false);
    });

    it("returns 401 when the lane flag is off", async () => {
        const res = await postChain("ethereum");
        expect(res.status).toBe(401);
        expect(forwardSessionlessCall).not.toHaveBeenCalled();
        expect(forwardRequest).not.toHaveBeenCalled();
    });

    it("forwards an allowed method when the lane is on", async () => {
        process.env.RPC_ALLOW_SESSIONLESS_APPS = "true";
        const res = await postChain("polygon", chainIdBody, { forwarded: "198.51.100.1, 203.0.113.77" });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ jsonrpc: "2.0", id: 1, result: "0x1" });
        expect(forwardSessionlessCall).toHaveBeenCalledWith(
            expect.objectContaining({ chain: "polygon", method: "eth_chainId", ip: "203.0.113.77" }),
            { skipRateLimit: true }
        );
        expect(RpcCaller.assertWithinSessionlessRateLimit).toHaveBeenCalledWith("203.0.113.77", 1);
        expect(forwardRequest).not.toHaveBeenCalled();
        expect(JSON.stringify(infoSpy.mock.calls)).not.toMatch(/secret|Bearer|https?:\/\//i);
    });

    it("rejects a chain outside the lane", async () => {
        process.env.RPC_ALLOW_SESSIONLESS_APPS = "true";
        const res = await postChain("solana");

        expect(res.status).toBe(400);
        expect(res.body.error).toBe("RPC_SESSIONLESS_CHAIN_NOT_ALLOWED");
        expect(forwardSessionlessCall).not.toHaveBeenCalled();
    });

    it("rejects a method outside the lane allowlist", async () => {
        process.env.RPC_ALLOW_SESSIONLESS_APPS = "true";
        const res = await postChain("ethereum", { jsonrpc: "2.0", id: 2, method: "eth_sendTransaction", params: [] });

        expect(res.status).toBe(403);
        expect(res.body.error).toBe("RPC_SESSIONLESS_METHOD_NOT_ALLOWED");
        expect(forwardSessionlessCall).not.toHaveBeenCalled();
    });

    it("rejects a request that sends an Origin header", async () => {
        process.env.RPC_ALLOW_SESSIONLESS_APPS = "true";
        const res = await postChain("bsc", chainIdBody, { origin: "https://test.example.com" });

        expect(res.status).toBe(403);
        expect(res.body.error).toBe("RPC_SESSIONLESS_ORIGIN_NOT_ALLOWED");
        expect(forwardSessionlessCall).not.toHaveBeenCalled();
    });

    it("rejects a batch larger than 3 and counts a batch of 3 per item", async () => {
        process.env.RPC_ALLOW_SESSIONLESS_APPS = "true";
        const call = (id) => ({ jsonrpc: "2.0", id, method: "eth_chainId", params: [] });
        const tooBig = await postChain("avalanche", [call(1), call(2), call(3), call(4)]);
        expect(tooBig.status).toBe(400);
        expect(tooBig.body.error).toBe("RPC_SESSIONLESS_BATCH_TOO_LARGE");
        expect(forwardSessionlessCall).not.toHaveBeenCalled();

        const ok = await postChain("avalanche", [call(1), call(2), call(3)]);
        expect(ok.status).toBe(200);
        expect(ok.body).toHaveLength(3);
        expect(forwardSessionlessCall).toHaveBeenCalledTimes(3);
        expect(RpcCaller.assertWithinSessionlessRateLimit).toHaveBeenCalledWith(expect.any(String), 3);
    });

    it("returns 401 after the sunset date", async () => {
        process.env.RPC_ALLOW_SESSIONLESS_APPS = "true";
        process.env.RPC_SESSIONLESS_SUNSET = "2020-01-01";
        const res = await postChain("ethereum");

        expect(res.status).toBe(401);
        expect(forwardSessionlessCall).not.toHaveBeenCalled();
    });

    it("allows eth_getLogs inside the block span and rejects a wider filter", async () => {
        process.env.RPC_ALLOW_SESSIONLESS_APPS = "true";
        const address = "0x0000000000000000000000000000000000000001";
        const wide = await postChain("ethereum", {
            jsonrpc: "2.0",
            id: 3,
            method: "eth_getLogs",
            params: [{ address, fromBlock: "0x1", toBlock: "0x1000" }],
        });
        expect(wide.status).toBe(400);
        expect(wide.body.error).toBe("RPC_SESSIONLESS_LOG_RANGE");
        expect(forwardSessionlessCall).not.toHaveBeenCalled();

        const missingAddress = await postChain("ethereum", {
            jsonrpc: "2.0",
            id: 4,
            method: "eth_getLogs",
            params: [{ fromBlock: "0x1", toBlock: "0x2" }],
        });
        expect(missingAddress.status).toBe(400);
        expect(missingAddress.body.error).toBe("RPC_SESSIONLESS_LOG_FILTER");

        const narrow = await postChain("ethereum", {
            jsonrpc: "2.0",
            id: 5,
            method: "eth_getLogs",
            params: [{ address, fromBlock: "0x10", toBlock: "0x14" }],
        });
        expect(narrow.status).toBe(200);
        expect(forwardSessionlessCall).toHaveBeenCalledWith(
            expect.objectContaining({ method: "eth_getLogs" }),
            { skipRateLimit: true }
        );
    });

    it("keeps an authenticated request on the protected route", async () => {
        process.env.RPC_ALLOW_SESSIONLESS_APPS = "true";
        config.extension.rpc.allowedRequestOrigins = ["chrome-extension://extensionidexample"];
        const res = await postChain("ethereum", chainIdBody, { authorization: `Bearer ${token}` });

        expect(res.status).toBe(200);
        expect(res.body.result).toBe("0x1");
        expect(forwardRequest).toHaveBeenCalledWith(
            expect.objectContaining({ chain: "ethereum", method: "eth_chainId" }),
            expect.objectContaining({ authUser: expect.objectContaining({ identifier: "device-1" }) }),
            {}
        );
        expect(forwardSessionlessCall).not.toHaveBeenCalled();
    });

    it("returns the lane rate-limit code", async () => {
        process.env.RPC_ALLOW_SESSIONLESS_APPS = "true";
        RpcCaller.assertWithinSessionlessRateLimit.mockRejectedValueOnce(
            Object.assign(new Error("RPC rate limit exceeded"), {
                status: 429,
                clientCode: "RPC_SESSIONLESS_RATE_LIMITED",
                retryAfterSeconds: 60,
            })
        );

        const res = await postChain("ethereum");
        expect(res.status).toBe(429);
        expect(res.body.error).toBe("RPC_SESSIONLESS_RATE_LIMITED");
        expect(res.headers["retry-after"]).toBe("60");
        expect(forwardSessionlessCall).not.toHaveBeenCalled();
    });
});
