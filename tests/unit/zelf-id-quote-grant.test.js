/**
 * Quote replay is an insert-first claim. Mongo must be up, or the confirm does not grant.
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { claimQuoteGrant, completeQuoteGrant, quoteHash, releaseQuoteGrant } = require("../../Repositories/ZelfID/modules/zelf-id-quote-grant.module");
const QuoteGrant = require("../../Repositories/ZelfID/models/zelf-id-quote-grant.model");
const PlanTerm = require("../../Repositories/ZelfID/models/zelf-id-plan-term.model");
const Coupon = require("../../Repositories/ZelfID/models/zelf-id-coupon.model");

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
        await PlanTerm.deleteMany({});
        await Coupon.deleteMany({});
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

    test("a pending claim inside its lease cannot be taken, and an expired one can", async () => {
        const fresh = { zelfName: "fresh.zelf", token: "quote-fresh", source: "whitelist" };
        await claimQuoteGrant(fresh);
        await expect(claimQuoteGrant(fresh)).rejects.toMatchObject({ clientCode: "in_progress" });

        const expired = { zelfName: "lease.zelf", token: "quote-lease", source: "whitelist" };
        const first = await claimQuoteGrant(expired);
        await QuoteGrant.updateOne({ _id: first.grant._id }, { $set: { claimedAt: new Date(Date.now() - 10 * 60 * 1000) } });
        const second = await claimQuoteGrant(expired);
        expect(second.state).toBe("claimed");
        expect(await QuoteGrant.countDocuments({ zelfName: "lease.zelf", status: "pending" })).toBe(1);
    });

    test("a re-claim after the grant landed marks the row done and does not create another term", async () => {
        const input = { zelfName: "landed.zelf", token: "quote-landed", source: "coupon" };
        const first = await claimQuoteGrant(input);
        await PlanTerm.create({
            zelfName: "landed.zelf",
            plan: "premium",
            duration: "1",
            paymentMethod: "coupon",
            quoteHash: quoteHash(input.token),
            planExpiresAt: "2027-01-01 00:00:00",
        });
        await QuoteGrant.updateOne({ _id: first.grant._id }, { $set: { claimedAt: new Date(Date.now() - 10 * 60 * 1000) } });

        const second = await claimQuoteGrant(input);
        expect(second.state).toBe("done");
        expect(second.grant.plan).toBe("premium");
        expect(second.grant.paymentMethod).toBe("coupon");
        expect(await PlanTerm.countDocuments({ zelfName: "landed.zelf" })).toBe(1);
        expect(await QuoteGrant.countDocuments({ zelfName: "landed.zelf", status: "done" })).toBe(1);
    });

    test("a redemption recorded for the quote is enough to finish a stuck pending row", async () => {
        const input = { zelfName: "redeemed.zelf", token: "quote-redeemed", source: "coupon" };
        const first = await claimQuoteGrant(input);
        await Coupon.create({
            id: "coupon-evidence",
            code: "EVIDENCE",
            percentOff: 100,
            plans: ["premium"],
            maxRedemptions: 2,
            createdBy: "admin@zelf.world",
            redemptions: [
                {
                    zelfId: "redeemed.zelf",
                    plan: "premium",
                    duration: "1y",
                    redeemedAt: new Date(),
                    key: "redemption-key",
                    quoteHash: quoteHash(input.token),
                },
            ],
        });
        await QuoteGrant.updateOne({ _id: first.grant._id }, { $set: { claimedAt: new Date(Date.now() - 10 * 60 * 1000) } });

        const second = await claimQuoteGrant(input);
        expect(second.state).toBe("done");
        expect(second.grant.couponId).toBe("coupon-evidence");
        expect((await Coupon.findOne({ code: "EVIDENCE" }).lean()).redemptions).toHaveLength(1);
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
