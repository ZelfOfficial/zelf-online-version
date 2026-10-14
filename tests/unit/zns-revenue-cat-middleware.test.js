const config = require("../../Core/config");
const { revenueCatWebhookValidation } = require("../../Repositories/ZelfNameService/middlewares/zns.middleware");

const ctxFor = (event) => ({ request: { body: { event } }, state: { user: { clientId: "c", email: "rc@zelf.world" } }, status: 200, body: null });

describe("v3 revenueCatWebhookValidation", () => {
    const saved = { env: config.env, revenueCat: config.revenueCat };
    beforeEach(() => { config.env = "production"; config.revenueCat = { allowedEmail: "rc@zelf.world" }; });
    afterEach(() => { config.env = saved.env; config.revenueCat = saved.revenueCat; });

    test("invalid event stops with 409 and does not call next", async () => {
        const ctx = ctxFor({ type: "NON_RENEWING_PURCHASE", id: "e1" });
        const next = jest.fn();
        await revenueCatWebhookValidation(ctx, next);
        expect(ctx.status).toBe(409);
        expect(next).not.toHaveBeenCalled();
    });

    test("TEST event passes through to the handler (acknowledged there)", async () => {
        const next = jest.fn();
        await revenueCatWebhookValidation(ctxFor({ type: "TEST", id: "t" }), next);
        expect(next).toHaveBeenCalled();
    });

    test("wrong JWT user is 403", async () => {
        const ctx = ctxFor({ type: "TEST" });
        ctx.state.user.email = "x@y.z";
        const next = jest.fn();
        await revenueCatWebhookValidation(ctx, next);
        expect(ctx.status).toBe(403);
        expect(next).not.toHaveBeenCalled();
    });
});
