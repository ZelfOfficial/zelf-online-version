const { errorHandler } = require("../../Core/http-handler");
const { mapGrantError } = require("../../Repositories/ZelfID/modules/zelf-id-grant-error.module");
const { restoredDurationForPlanTerm } = require("../../Repositories/ZelfID/modules/zelf-id-plan-term-duration");
const { assertAllowedDatabase, databaseNameFromUri, redactSecrets, summarizeRepair } = require("../../scripts/repair-zelf-id-plan-term-duration");
const moment = require("moment");

describe("grant error responses", () => {
    test("mongo connectivity during confirm is a 503 without the driver message", () => {
        const mapped = mapGrantError(Object.assign(new Error("Connection was force closed"), { name: "MongoNetworkError" }));
        const body = errorHandler(mapped, null);

        expect(mapped.status).toBe(503);
        expect(body).toMatchObject({ status: 503, code: "QUOTE_STORE_UNAVAILABLE", message: "QUOTE_STORE_UNAVAILABLE" });
        expect(JSON.stringify(body)).not.toMatch(/force closed/i);
    });

    test("an unexpected grant failure is logged and returned as a generic code", () => {
        const spy = jest.spyOn(console, "error").mockImplementation(() => {});
        const mapped = mapGrantError(new Error("secret stack detail from the driver"));
        const body = errorHandler(mapped, null);

        expect(body).toMatchObject({ status: 500, code: "SERVICE_UNAVAILABLE", message: "SERVICE_UNAVAILABLE" });
        expect(JSON.stringify(body)).not.toMatch(/secret stack/);
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });

    test("a client 409 is left unchanged", () => {
        const error = new Error("409:UPGRADE_CREDIT_CHANGED");
        error.clientCode = "UPGRADE_CREDIT_CHANGED";
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
        const replica =
            "mongodb://appuser:s3cret-pass@db1.internal:27017,db2.internal:27017,db3.internal:27017/wallet_development?replicaSet=rs0&authSource=admin";
        expect(databaseNameFromUri(replica)).toBe("wallet_development");
        expect(databaseNameFromUri("mongodb+srv://appuser:s3cret-pass@cluster.example.net/wallet_development?retryWrites=true")).toBe(
            "wallet_development"
        );
        expect(assertAllowedDatabase({ uri: replica })).toBe("wallet_development");
        expect(assertAllowedDatabase({ uri: "mongodb://127.0.0.1:27017/wallet_development" })).toBe("wallet_development");

        const refuse = (input) => {
            try {
                assertAllowedDatabase(input);
            } catch (error) {
                expect(error.message).not.toMatch(/s3cret-pass/);
                expect(error.message).not.toMatch(/mongodb(\+srv)?:\/\//);
                throw error;
            }
        };
        expect(() => refuse({ uri: replica.replace("/wallet_development", "/wallet_production") })).toThrow(/allowlist/);
        expect(() => refuse({ uri: replica, targetDb: "wallet_production" })).toThrow(/does not match/);
        expect(() =>
            refuse({
                uri: "mongodb://appuser:s3cret-pass@db1.internal:27017,db2.internal:27017/wallet_production?replicaSet=rs0",
                targetDb: "wallet_production",
            })
        ).toThrow(/allowlist/);
        expect(summarizeRepair({ apply: false, scanned: 4, changes: [{ zelfName: "a.zelf" }] })).toEqual({
            apply: false,
            scanned: 4,
            wouldRestore: 1,
            changes: [{ zelfName: "a.zelf" }],
        });
        expect(summarizeRepair({ apply: true, scanned: 4, changes: [{ zelfName: "a.zelf" }] }).restored).toBe(1);
        expect(redactSecrets(`connect failed ${replica}`)).not.toMatch(/s3cret-pass/);
    });
});
