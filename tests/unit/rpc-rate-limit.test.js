jest.mock("../../Repositories/RPCCaller/models/rpc-caller.model", () => ({
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
}));

jest.mock("../../Repositories/RPCCaller/models/rpc-caller-window.model", () => ({
    findOneAndUpdate: jest.fn(),
    aggregate: jest.fn(),
}));

const RpcCaller = require("../../Repositories/RPCCaller/models/rpc-caller.model");
const RpcCallerWindow = require("../../Repositories/RPCCaller/models/rpc-caller-window.model");
const {
    assertNotBanned,
    assertWithinRateLimit,
    assertWithinSessionlessRateLimit,
    sessionlessSubject,
    SESSIONLESS_GLOBAL_SUBJECT,
    userSubject,
} = require("../../Repositories/RPCCaller/modules/rpc-caller.module");

describe("RPC caller rate limits", () => {
    beforeEach(() => {
        RpcCaller.findOne.mockReset();
        RpcCallerWindow.findOneAndUpdate.mockReset();
        RpcCallerWindow.aggregate.mockReset();
        RpcCallerWindow.aggregate.mockResolvedValue([{ total: 1 }]);
    });

    it("rejects a banned IP before a request is counted", async () => {
        RpcCaller.findOne.mockReturnValue({
            select: () => ({ lean: async () => ({ banned: true }) }),
        });

        await expect(assertNotBanned("203.0.113.9")).rejects.toMatchObject({
            status: 403,
            clientCode: "rpc_caller_banned",
        });
        expect(RpcCallerWindow.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it("counts the IP and the user in separate minute buckets", async () => {
        const counts = {};
        RpcCallerWindow.findOneAndUpdate.mockImplementation((filter) => ({
            lean: async () => {
                counts[filter.ip] = (counts[filter.ip] || 0) + 1;
                return { count: counts[filter.ip] };
            },
        }));

        await assertWithinRateLimit("203.0.113.9", { userKey: "device-hash" });

        const subjects = RpcCallerWindow.findOneAndUpdate.mock.calls.map((call) => call[0].ip);
        expect(subjects).toEqual(["203.0.113.9", userSubject("device-hash")]);
        expect(subjects[1].startsWith("u:")).toBe(true);
        expect(subjects[1]).not.toContain("device-hash");
    });

    it("returns 429 when the per-IP minute bucket is exhausted", async () => {
        RpcCallerWindow.findOneAndUpdate.mockReturnValue({
            lean: async () => ({ count: 100000 }),
        });

        await expect(assertWithinRateLimit("203.0.113.9")).rejects.toMatchObject({
            status: 429,
            clientCode: "rpc_rate_limited",
        });
    });

    it("counts a sessionless batch on its own IP subject and the global subject", async () => {
        RpcCallerWindow.findOneAndUpdate.mockReturnValue({
            lean: async () => ({ count: 1 }),
        });

        await assertWithinSessionlessRateLimit("203.0.113.9", 3);

        const updates = RpcCallerWindow.findOneAndUpdate.mock.calls.map((call) => ({
            ip: call[0].ip,
            inc: call[1].$inc.count,
        }));
        expect(updates).toEqual([
            { ip: sessionlessSubject("203.0.113.9"), inc: 3 },
            { ip: SESSIONLESS_GLOBAL_SUBJECT, inc: 3 },
        ]);
        expect(updates[0].ip).not.toBe("203.0.113.9");
        expect(updates[0].ip.length).toBeLessThanOrEqual(45);
        expect(updates[0].ip.startsWith("s:")).toBe(true);
    });

    it("returns RPC_SESSIONLESS_RATE_LIMITED from the compatibility lane bucket", async () => {
        RpcCallerWindow.findOneAndUpdate.mockReturnValue({
            lean: async () => ({ count: 100000 }),
        });

        await expect(assertWithinSessionlessRateLimit("203.0.113.9", 1)).rejects.toMatchObject({
            status: 429,
            clientCode: "RPC_SESSIONLESS_RATE_LIMITED",
        });
    });

    it("returns 429 when the rolling window is exhausted", async () => {
        RpcCallerWindow.findOneAndUpdate.mockReturnValue({
            lean: async () => ({ count: 1 }),
        });
        RpcCallerWindow.aggregate.mockResolvedValue([{ total: 100000 }]);

        await expect(assertWithinRateLimit("203.0.113.9", { userKey: "device-hash" })).rejects.toMatchObject({
            status: 429,
            clientCode: "rpc_rate_limited",
        });
    });
});
