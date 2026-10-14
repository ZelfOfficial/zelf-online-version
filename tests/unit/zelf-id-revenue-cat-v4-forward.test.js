const { isZelfIdProductEvent, forwardToV4 } = require("../../Repositories/ZelfIDRevenueCatV4/zelf-id-revenue-cat-v4.module");

describe("isZelfIdProductEvent", () => {
    test.each([
        "zelf_premium_1y", "zelf_unlimited_1y:annual", "zelf_premium_2y", "zelf_unlimited_3y", "zelf_premium_lifetime",
        "zns_6_to_27_char_2_years", "zns_3_char_lifetime_years", "zelf_name_service_char_6_to_27_years_1",
    ])("routes %s to v4", (product_id) => expect(isZelfIdProductEvent({ product_id })).toBe(true));

    test.each(["zelf_keys_plan_pro:zelf-keys-pro", "zelf_keys_plan_basic", "zelf_premium_5y", "", undefined])("keeps %s on v3", (product_id) =>
        expect(isZelfIdProductEvent({ product_id })).toBe(false));

    test("PRODUCT_CHANGE uses new_product_id too", () =>
        expect(isZelfIdProductEvent({ product_id: "other", new_product_id: "zelf_unlimited_1y" })).toBe(true));
    test("no event", () => expect(isZelfIdProductEvent(undefined)).toBe(false));
});

describe("forwardToV4", () => {
    const env = { ...process.env };
    afterEach(() => { process.env = { ...env }; });
    const payload = { api_version: "1.0", event: { type: "NON_RENEWING_PURCHASE", id: "e1", product_id: "zelf_premium_2y" } };

    test("503 when the v4 authorization is not configured (RevenueCat retries)", async () => {
        delete process.env.V4_REVENUECAT_WEBHOOK_AUTHORIZATION;
        const http = { post: jest.fn() };
        await expect(forwardToV4(payload, { http })).rejects.toMatchObject({ status: 503 });
        expect(http.post).not.toHaveBeenCalled();
    });

    test("posts the unchanged payload with the configured header and returns v4 data", async () => {
        process.env.V4_REVENUECAT_WEBHOOK_AUTHORIZATION = "Bearer k";
        process.env.V4_REVENUECAT_WEBHOOK_URL = "https://v4.example/api/zelf-ids/revenue-cat";
        const http = { post: jest.fn().mockResolvedValue({ status: 200, data: { data: { status: "success", action: "already_extended" } } }) };
        const out = await forwardToV4(payload, { http });
        expect(http.post).toHaveBeenCalledWith("https://v4.example/api/zelf-ids/revenue-cat", payload, expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer k" }) }));
        expect(out).toEqual({ forwardedTo: "v4", result: { status: "success", action: "already_extended" } });
    });

    test("v4 409 stays 409 (permanent, e.g. plan_not_allowed_for_name)", async () => {
        process.env.V4_REVENUECAT_WEBHOOK_AUTHORIZATION = "k";
        const http = { post: jest.fn().mockResolvedValue({ status: 409, data: { message: "plan_not_allowed_for_name" } }) };
        await expect(forwardToV4(payload, { http })).rejects.toMatchObject({ status: 409, message: "plan_not_allowed_for_name" });
    });

    test("v4 401 becomes 503 so the purchase is retried, not dropped", async () => {
        process.env.V4_REVENUECAT_WEBHOOK_AUTHORIZATION = "k";
        const http = { post: jest.fn().mockResolvedValue({ status: 401, data: { validationError: "Invalid authorization" } }) };
        await expect(forwardToV4(payload, { http })).rejects.toMatchObject({ status: 503 });
    });

    test("network failure becomes 502", async () => {
        process.env.V4_REVENUECAT_WEBHOOK_AUTHORIZATION = "k";
        const http = { post: jest.fn().mockRejectedValue(new Error("ECONNRESET")) };
        await expect(forwardToV4(payload, { http })).rejects.toMatchObject({ status: 502 });
    });
});
