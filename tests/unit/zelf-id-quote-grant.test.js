/**
 * Quote replay is an insert-first claim. Mongo must be up, or the confirm does not grant.
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { claimQuoteGrant, completeQuoteGrant, releaseQuoteGrant } = require("../../Repositories/ZelfID/modules/zelf-id-quote-grant.module");
const QuoteGrant = require("../../Repositories/ZelfID/models/zelf-id-quote-grant.model");

describe("quote grant claim", () => {
    let memory;

    beforeAll(async () => {
        memory = await MongoMemoryServer.create();
        await mongoose.connect(memory.getUri());
    }, 180000);

    afterAll(async () => {
        await mongoose.disconnect();
        if (memory) await memory.stop();
    });

    beforeEach(async () => {
        await QuoteGrant.deleteMany({});
    });

    test("parallel claims of one quote let one proceed and reject the rest", async () => {
        const input = { zelfName: "race.zelf", token: "same-signed-quote", source: "whitelist" };
        const results = await Promise.allSettled([claimQuoteGrant(input), claimQuoteGrant(input), claimQuoteGrant(input)]);
        const claimed = results.filter((result) => result.status === "fulfilled" && result.value.state === "claimed");
        const rejected = results.filter((result) => result.status === "rejected");

        expect(claimed).toHaveLength(1);
        expect(rejected).toHaveLength(2);
        expect(rejected.every((result) => result.reason.clientCode === "in_progress")).toBe(true);
        expect(await QuoteGrant.countDocuments({ status: "pending" })).toBe(1);
    });

    test("a finished claim is replayed, and a failed claim can be retried", async () => {
        const input = { zelfName: "retry.zelf", token: "quote-token", source: "whitelist" };
        const first = await claimQuoteGrant(input);
        expect(first.state).toBe("claimed");

        await releaseQuoteGrant(input);
        expect(await QuoteGrant.countDocuments({})).toBe(0);

        const second = await claimQuoteGrant(input);
        expect(second.state).toBe("claimed");
        await completeQuoteGrant({ ...input, paymentMethod: "whitelist", plan: "premium", duration: "1" });

        const replay = await claimQuoteGrant(input);
        expect(replay.state).toBe("done");
        expect(replay.grant.paymentMethod).toBe("whitelist");
        expect(replay.grant.duration).toBe("1");
    });
});

describe("quote grant without mongo", () => {
    test("a confirm cannot grant when the quote store is down", async () => {
        if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
        await expect(claimQuoteGrant({ zelfName: "down.zelf", token: "quote", source: "whitelist" })).rejects.toMatchObject({
            status: 503,
            clientCode: "quote_store_unavailable",
        });
    });
});
