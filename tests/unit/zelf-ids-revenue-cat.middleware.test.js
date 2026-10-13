jest.mock("../../Repositories/Tags/middlewares/tags.middleware", () => ({}));
jest.mock("../../Repositories/Tags/middlewares/my-tags.middleware", () => ({}));
jest.mock("../../Repositories/ZelfID/modules/zelf-ids-payment.module", () => ({
    isTagPayReducedFeeClientHeaderHonored: jest.fn(() => false),
}));

const config = require("../../Core/config");
const { revenueCatWebhookValidation } = require("../../Repositories/ZelfID/middlewares/zelf-id.middleware");

const SECRET = "rc_webhook_secret_123";

const event = {
    type: "NON_RENEWING_PURCHASE",
    id: "evt_1",
    product_id: "zelf_premium_2y",
    transaction_id: "2000000000000001",
    environment: "PRODUCTION",
    price: 43.49,
    subscriber_attributes: {},
};

const createCtx = (body, authorization) => ({
    request: { body },
    headers: authorization === undefined ? {} : { authorization },
    state: {},
    status: 200,
    body: null,
});

describe("zelf-ids revenueCatWebhookValidation (static Authorization)", () => {
    const original = { env: config.env, revenueCat: config.revenueCat };

    beforeEach(() => {
        config.env = "production";
        config.revenueCat = { webhookAuthorization: SECRET };
    });

    afterEach(() => {
        config.env = original.env;
        config.revenueCat = original.revenueCat;
    });

    test("accepts the configured header without any JWT", async () => {
        const ctx = createCtx({ event: { ...event, store: "APP_STORE", app_user_id: "$RCAnonymousID:x" } }, SECRET);
        const next = jest.fn();
        await revenueCatWebhookValidation(ctx, next);
        expect(next).toHaveBeenCalled();
    });

    test("accepts Bearer form either way round", async () => {
        const next = jest.fn();
        await revenueCatWebhookValidation(createCtx({ event }, `Bearer ${SECRET}`), next);
        config.revenueCat = { webhookAuthorization: `Bearer ${SECRET}` };
        await revenueCatWebhookValidation(createCtx({ event }, SECRET), next);
        expect(next).toHaveBeenCalledTimes(2);
    });

    test("rejects a wrong or missing header with 401", async () => {
        for (const header of ["nope", undefined, "Bearer eyJhbGciOiJIUzI1NiJ9.x.y"]) {
            const ctx = createCtx({ event }, header);
            const next = jest.fn();
            await revenueCatWebhookValidation(ctx, next);
            expect(ctx.status).toBe(401);
            expect(next).not.toHaveBeenCalled();
        }
    });

    test("fails closed with 503 when REVENUECAT_WEBHOOK_AUTHORIZATION is unset", async () => {
        config.revenueCat = {};
        const ctx = createCtx({ event }, SECRET);
        const next = jest.fn();
        await revenueCatWebhookValidation(ctx, next);
        expect(ctx.status).toBe(503);
        expect(next).not.toHaveBeenCalled();
    });

    test("an invalid event stops with 409", async () => {
        const ctx = createCtx({ event: { type: "NON_RENEWING_PURCHASE" } }, SECRET);
        const next = jest.fn();
        await revenueCatWebhookValidation(ctx, next);
        expect(ctx.status).toBe(409);
        expect(next).not.toHaveBeenCalled();
    });
});
