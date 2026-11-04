process.env.FACE_BODY_WHITELIST_ENABLED = "true";
process.env.FACE_BODY_STRICT_WHITELIST = "true";

jest.mock("../../Repositories/Tags/middlewares/tags.middleware", () => ({
    validateDomainAndName: jest.fn(async () => ({ valid: true })),
}));

jest.mock("../../Repositories/Rewards/modules/rewards.module", () => ({
    dailyRewards: async function dailyRewards() {},
    getRouletteWheel: async function getRouletteWheel() {},
    rewardFirstTransaction: async function rewardFirstTransaction() {},
    getUserRewardHistory: async function getUserRewardHistory() {},
    getUserRewardStats: async function getUserRewardStats() {},
}));

jest.mock("../../Repositories/Face/middlewares/face.middleware", () => ({
    gate: (action) => {
        const handler = async function faceGate(_ctx, next) {
            await next();
        };
        handler.action = action;
        return handler;
    },
}));

const { dailyRewardsValidation, rouletteWheelValidation } = require("../../Repositories/Rewards/middlewares/rewards.middleware");
const { pickWhitelistedBody } = require("../../Repositories/Face/modules/face-body-whitelist.module");

const ctxFor = (body) => ({
    request: { body },
    state: {},
    status: 200,
    body: undefined,
});

describe("daily reward validation", () => {
    it("requires faceBase64 with an identity code", async () => {
        const ctx = ctxFor({ tagName: "alice", domain: "zelf" });
        const next = jest.fn();

        await dailyRewardsValidation(ctx, next);

        expect(next).not.toHaveBeenCalled();
        expect(ctx.status).toBe(400);
        expect(ctx.body).toEqual({
            message: "ERR_IDENTITY_VERIFICATION_REQUIRED",
            code: "ERR_IDENTITY_VERIFICATION_REQUIRED",
        });
    });

    it("rejects a blank face the same way", async () => {
        const ctx = ctxFor({ tagName: "alice", domain: "zelf", faceBase64: "   " });

        await dailyRewardsValidation(ctx, async () => {});

        expect(ctx.status).toBe(400);
        expect(ctx.body.code).toBe("ERR_IDENTITY_VERIFICATION_REQUIRED");
    });

    it("still reports a missing tagName as a validation error", async () => {
        const ctx = ctxFor({ domain: "zelf", faceBase64: "face" });

        await dailyRewardsValidation(ctx, async () => {});

        expect(ctx.status).toBe(400);
        expect(ctx.body.error).toMatch(/tagName/);
        expect(ctx.body.code).toBeUndefined();
    });
});

describe("roulette status stays readable without a face", () => {
    it("does not ask for identity verification", async () => {
        const ctx = {
            request: { query: { tagName: "alice", domain: "zelf" } },
            state: {},
            status: 200,
        };
        const next = jest.fn();

        await rouletteWheelValidation(ctx, next);

        expect(next).toHaveBeenCalled();
        expect(ctx.body?.code).not.toBe("ERR_IDENTITY_VERIFICATION_REQUIRED");
        expect(JSON.stringify(ctx.body || {})).not.toMatch(/faceBase64/);
    });
});

describe("daily reward route wiring", () => {
    it("puts the face gate on the claim and leaves roulette status unchanged", () => {
        const routes = [];
        const server = {
            get(path, ...handlers) {
                routes.push({ method: "get", path, handlers });
            },
            post(path, ...handlers) {
                routes.push({ method: "post", path, handlers });
            },
        };

        require("../../Repositories/Rewards/routes/rewards.route")(server);

        const daily = routes.find((route) => route.path === "/api/rewards/daily");
        const wheel = routes.find((route) => route.path === "/api/rewards/roulette-wheel");
        const first = routes.find((route) => route.path === "/api/rewards/first-transaction");

        expect(daily.handlers.map((handler) => handler.name)).toEqual(["dailyRewardsValidation", "faceGate", "dailyRewards"]);
        expect(daily.handlers[1].action).toBe("daily-reward");
        expect(wheel.handlers).toHaveLength(2);
        expect(wheel.handlers.some((handler) => handler.action === "daily-reward")).toBe(false);
        expect(first.handlers).toHaveLength(2);
    });
});

describe("daily-reward body whitelist", () => {
    it("keeps the claim fields and drops anything else when strict mode is on", () => {
        const result = pickWhitelistedBody(
            {
                tagName: "alice",
                domain: "zelf",
                faceBase64: "face",
                masterPassword: "secret",
                password: "secret",
                faceNonce: "nonce",
                extraField: "drop-me",
            },
            "daily-reward"
        );

        expect(result.rejected).toEqual(["extraField"]);
        expect(result.body).toEqual({
            tagName: "alice",
            domain: "zelf",
            faceBase64: "face",
            masterPassword: "secret",
            password: "secret",
            faceNonce: "nonce",
        });
    });
});
