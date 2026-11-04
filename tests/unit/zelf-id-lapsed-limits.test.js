/**
 * Zelf Keys `/limits` loads the tag through Tags `searchTag`, which merges the Mongo plan term.
 * A lapsed term on a Free lease must select the free cap row.
 */
const mongoose = require("mongoose");
const moment = require("moment");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { savePlanTerm, readLeaseSearchResult } = require("../../Repositories/ZelfID/modules/zelf-id-plan-term.module");
const { planForLimits } = require("../../Repositories/ZelfID/modules/zelf-id-plan.module");

const CAPS = {
    free: { passwords: 5, zotp: 3 },
    premium: { passwords: 100, zotp: 100 },
};

describe("lapsed plan term and /limits caps", () => {
    let memory;

    beforeAll(async () => {
        memory = await MongoMemoryServer.create();
        await mongoose.connect(memory.getUri());
    }, 180000);

    afterAll(async () => {
        await mongoose.disconnect();
        if (memory) await memory.stop();
    });

    test("a lapsed paid term on a Free lease gives free caps", async () => {
        const leaseExpiresAt = "2126-10-24 18:00:00";
        await savePlanTerm({
            zelfName: "lapsed.zelf",
            plan: "premium",
            planExpiresAt: moment.utc().subtract(2, "day").format("YYYY-MM-DD HH:mm:ss"),
            paymentMethod: "coupon",
            duration: "1",
        });

        const searchResult = {
            tagObject: {
                publicData: {
                    tagName: "lapsed.zelf",
                    domain: "zelf",
                    type: "mainnet",
                    plan: "premium",
                    duration: "100",
                    expiresAt: leaseExpiresAt,
                },
            },
        };

        await readLeaseSearchResult(searchResult);

        const plan = planForLimits(searchResult.tagObject.publicData);
        expect(plan).toBe("free");
        expect(CAPS[plan]).toEqual(CAPS.free);
        expect(searchResult.tagObject.publicData.duration).toBe("100");
        expect(searchResult.tagObject.publicData.planDuration).toBe("1");
        expect(searchResult.tagObject.publicData.expiresAt).toBe(leaseExpiresAt);
    });
});
