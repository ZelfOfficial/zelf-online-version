const { errorHandler } = require("../../Core/http-handler");
const { mapGrantError } = require("../../Repositories/ZelfID/modules/zelf-id-grant-error.module");
const { restoredDurationForPlanTerm } = require("../../Repositories/ZelfID/modules/zelf-id-plan-term-duration");
const moment = require("moment");

describe("grant error responses", () => {
    test("mongo connectivity during confirm is a 503 without the driver message", () => {
        const mapped = mapGrantError(Object.assign(new Error("Connection was force closed"), { name: "MongoNetworkError" }));
        const body = errorHandler(mapped, null);

        expect(mapped.status).toBe(503);
        expect(body).toMatchObject({ status: 503, code: "quote_store_unavailable", message: "quote_store_unavailable" });
        expect(JSON.stringify(body)).not.toMatch(/force closed/i);
    });

    test("an unexpected grant failure is logged and returned as a generic code", () => {
        const spy = jest.spyOn(console, "error").mockImplementation(() => {});
        const mapped = mapGrantError(new Error("secret stack detail from the driver"));
        const body = errorHandler(mapped, null);

        expect(body).toMatchObject({ status: 500, code: "service_unavailable", message: "service_unavailable" });
        expect(JSON.stringify(body)).not.toMatch(/secret stack/);
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });

    test("a client 409 is left unchanged", () => {
        const error = new Error("409:upgrade_credit_changed");
        error.clientCode = "upgrade_credit_changed";
        expect(mapGrantError(error)).toBe(error);
    });
});

describe("plan term duration repair", () => {
    test("derives a cleared duration from planExpiresAt minus the term start and skips a stored duration", () => {
        const createdAt = new Date("2026-01-01T00:00:00.000Z");
        const planExpiresAt = moment.utc(createdAt).add(1, "year").format("YYYY-MM-DD HH:mm:ss");

        expect(restoredDurationForPlanTerm({ duration: null, planExpiresAt, createdAt })).toBe("1");
        expect(restoredDurationForPlanTerm({ duration: "", planExpiresAt, createdAt })).toBe("1");
        expect(restoredDurationForPlanTerm({ duration: "1", planExpiresAt, createdAt })).toBeNull();
        expect(restoredDurationForPlanTerm({ duration: null, planExpiresAt: null, createdAt })).toBeNull();
        expect(
            restoredDurationForPlanTerm({
                duration: null,
                planExpiresAt: moment.utc(createdAt).add(5, "year").add(3, "hour").format("YYYY-MM-DD HH:mm:ss"),
                createdAt,
            })
        ).toBe("5");
    });
});
