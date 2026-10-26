jest.mock("../../Repositories/Tags/middlewares/tags.middleware", () => ({ validateDomainAndName: jest.fn(async () => ({ valid: true })) }));
jest.mock("../../Repositories/Tags/middlewares/my-tags.middleware", () => ({}));
jest.mock("../../Repositories/ZelfID/modules/zelf-ids-payment.module", () => ({ isTagPayReducedFeeClientHeaderHonored: jest.fn(() => false) }));
jest.mock("../../Repositories/Tags/config/supported-domains", () => {
    const { Domain } = jest.requireActual("../../Repositories/Tags/modules/domain.class");
    const P = { 1: 29, 2: 43.49, 3: 56.99, lifetime: 144.99 };
    const U = { 1: 99, 2: 148.99, 3: 192.99, lifetime: 494.99 };
    const d = new Domain({
        name: "zelf",
        tags: {
            payment: { planPricing: { premium: { "6-15": P, "16-27": P }, unlimited: { 1: U, 2: U, 3: U, 4: U, 5: U, "6-15": U, "16-27": U } } },
        },
    });
    return { getDomainConfig: jest.fn(() => d) };
});

const { paymentOptionsValidation, stripeCheckoutValidation } = require("../../Repositories/ZelfID/middlewares/zelf-id.middleware");

const run = async (mw, where, params) => {
    const ctx = { request: { query: {}, body: {} }, status: 200, body: null, get: () => "" };
    ctx.request[where] = params;
    const next = jest.fn();
    await mw(ctx, next);
    return { status: ctx.status, body: ctx.body, next: next.mock.calls.length };
};

describe("license-derived duration/plan validation", () => {
    test("payment-options: license durations pass, 4 and 5 rejected", async () => {
        expect(
            (await run(paymentOptionsValidation, "query", { tagName: "abcdefgh.zelf", domain: "zelf", duration: "2", plan: "premium" })).next
        ).toBe(1);
        expect((await run(paymentOptionsValidation, "query", { tagName: "abcdefgh.zelf", domain: "zelf", duration: "999" })).next).toBe(1);
        for (const duration of ["4", "5"]) {
            const r = await run(paymentOptionsValidation, "query", { tagName: "abcdefgh.zelf", domain: "zelf", duration, plan: "premium" });
            expect(r).toMatchObject({ status: 409, next: 0, body: { validationError: "PLAN_DURATION_NOT_OFFERED_BY_LICENSE" } });
        }
    });

    test("payment-options: premium on a 5-char name is rejected; unlimited ok", async () => {
        const r = await run(paymentOptionsValidation, "query", { tagName: "abcde.zelf", domain: "zelf", duration: "1", plan: "premium" });
        expect(r).toMatchObject({ status: 409, body: { validationError: "PLAN_NOT_OFFERED_FOR_NAME" } });
        expect((await run(paymentOptionsValidation, "query", { tagName: "abcde.zelf", domain: "zelf", duration: "1" })).next).toBe(1);
    });

    test("stripe checkout: duration 4 rejected", async () => {
        const r = await run(stripeCheckoutValidation, "body", {
            tagName: "abcdefgh.zelf",
            domain: "zelf",
            duration: "4",
            plan: "unlimited",
            token: "t",
        });
        expect(r).toMatchObject({ status: 409, next: 0 });
    });
});
