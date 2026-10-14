jest.mock("../../Repositories/ZelfNameService/modules/zns.module", () => ({}));
jest.mock("../../Repositories/ZelfNameService/modules/zns.v2.module", () => ({}));
jest.mock("../../Repositories/ZelfNameService/modules/zns-token.module", () => ({}));
jest.mock("../../Repositories/ZelfNameService/modules/my-zns.module", () => ({}));
jest.mock("../../Repositories/ZelfNameService/modules/zns-recovery.module", () => ({}));
jest.mock("../../Repositories/ZelfNameService/modules/revenue-cat.module", () => ({ webhookHandler: jest.fn(async () => ({ v3: true })) }));
jest.mock("../../Repositories/ZelfIDRevenueCatV4/zelf-id-revenue-cat-v4.module", () => ({
    ...jest.requireActual("../../Repositories/ZelfIDRevenueCatV4/zelf-id-revenue-cat-v4.module"),
    forwardToV4: jest.fn(async () => ({ forwardedTo: "v4" })),
}));
const RevenueCatModule = require("../../Repositories/ZelfNameService/modules/revenue-cat.module");
const V4 = require("../../Repositories/ZelfIDRevenueCatV4/zelf-id-revenue-cat-v4.module");
const { revenueCatWebhook } = require("../../Repositories/ZelfNameService/controllers/zns.controller");

const ctxFor = (event) => ({ request: { body: { event } }, status: 200, body: null });

describe("v3 RevenueCat controller dispatch", () => {
    beforeEach(() => jest.clearAllMocks());

    test("Zelf ID product goes to v4, not v3", async () => {
        const ctx = ctxFor({ type: "INITIAL_PURCHASE", product_id: "zelf_premium_1y" });
        await revenueCatWebhook(ctx);
        expect(V4.forwardToV4).toHaveBeenCalledWith(ctx.request.body);
        expect(RevenueCatModule.webhookHandler).not.toHaveBeenCalled();
        expect(ctx.body).toEqual({ data: { forwardedTo: "v4" } });
    });

    test("Zelf Keys product stays on v3", async () => {
        const ctx = ctxFor({ type: "INITIAL_PURCHASE", product_id: "zelf_keys_plan_pro:zelf-keys-pro" });
        await revenueCatWebhook(ctx);
        expect(RevenueCatModule.webhookHandler).toHaveBeenCalled();
        expect(V4.forwardToV4).not.toHaveBeenCalled();
    });

    test("forward error status is passed through", async () => {
        V4.forwardToV4.mockRejectedValueOnce(Object.assign(new Error("v4_revenuecat_forward_not_configured"), { status: 503 }));
        jest.spyOn(console, "error").mockImplementation(() => {});
        const ctx = ctxFor({ type: "NON_RENEWING_PURCHASE", product_id: "zelf_unlimited_2y" });
        await revenueCatWebhook(ctx);
        expect(ctx.status).toBe(503);
        console.error.mockRestore();
    });
});
