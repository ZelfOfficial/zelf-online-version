const { errorHandler } = require("../../Core/http-handler");
const { mapGrantError } = require("../../Repositories/ZelfID/modules/zelf-id-grant-error.module");
const { restoredDurationForPlanTerm } = require("../../Repositories/ZelfID/modules/zelf-id-plan-term-duration");
const { assertAllowedDatabase, summarizeRepair } = require("../../scripts/repair-zelf-id-plan-term-duration");
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
        const renewed = { duration: null, planExpiresAt, createdAt, updatedAt: new Date("2026-06-01T00:00:00.000Z") };
        expect(restoredDurationForPlanTerm(renewed)).toBeNull();
        expect(restoredDurationForPlanTerm({ ...renewed, termStartedAt: createdAt })).toBe("1");
        expect(
            restoredDurationForPlanTerm({
                duration: null,
                planExpiresAt: moment.utc(createdAt).add(5, "year").add(3, "hour").format("YYYY-MM-DD HH:mm:ss"),
                createdAt,
            })
        ).toBe("5");
    });

    test("the repair script allowlist refuses an unnamed database and labels a dry run wouldRestore", () => {
        expect(assertAllowedDatabase({ uri: "mongodb://127.0.0.1:27017/wallet_development" })).toBe("wallet_development");
        expect(assertAllowedDatabase({ uri: "mongodb+srv://user:pw@host/other_db", targetDb: "other_db" })).toBe("other_db");
        expect(() => assertAllowedDatabase({ uri: "mongodb+srv://user:pw@host/zelf_prod" })).toThrow(/Refusing database zelf_prod/);
        expect(() => assertAllowedDatabase({ uri: "mongodb://127.0.0.1:27017/wallet_development", targetDb: "other_db" })).toThrow(
            /does not match/
        );
        expect(summarizeRepair({ apply: false, scanned: 4, changes: [{ zelfName: "a.zelf" }] })).toEqual({
            apply: false,
            scanned: 4,
            wouldRestore: 1,
            changes: [{ zelfName: "a.zelf" }],
        });
        expect(summarizeRepair({ apply: true, scanned: 4, changes: [{ zelfName: "a.zelf" }] }).restored).toBe(1);
    });
});
