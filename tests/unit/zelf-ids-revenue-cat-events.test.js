// In-memory stand-in for the RevenueCatProcessedEvent collection with a real unique constraint on eventId.
const docs = new Map();
jest.mock("../../Repositories/ZelfID/models/revenue-cat-processed-event.model", () => ({
    create: jest.fn(async (doc) => {
        await new Promise((r) => setImmediate(r));
        if (docs.has(doc.eventId)) throw Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
        docs.set(doc.eventId, { ...doc });
        return doc;
    }),
    findOneAndUpdate: jest.fn((filter, update) => ({
        lean: async () => {
            const d = docs.get(filter.eventId);
            if (!d || d.status !== filter.status || !(d.claimedAt < filter.claimedAt.$lt)) return null;
            Object.assign(d, update.$set);
            return d;
        },
    })),
    deleteOne: jest.fn(async (filter) => {
        const d = docs.get(filter.eventId);
        if (d && d.status === filter.status) docs.delete(filter.eventId);
    }),
    updateOne: jest.fn(async (filter, update) => Object.assign(docs.get(filter.eventId) || {}, update.$set)),
    createIndexes: jest.fn(async () => undefined),
}));

jest.mock("../../Repositories/Tags/config/supported-domains", () => {
    const { Domain } = jest.requireActual("../../Repositories/Tags/modules/domain.class");
    const cells = { 1: 29, 2: 43.49, 3: 56.99, lifetime: 144.99 };
    const license = { name: "zelf", tags: { payment: { planPricing: { premium: { "6-27": cells }, unlimited: { "1-27": cells } } } } };
    return { getDomainConfig: jest.fn(() => Object.assign(new Domain(license), { getTagKey: () => "tagName" })) };
});

const record = {};
jest.mock("../../Repositories/ZelfID/modules/zelf-id.module", () => ({
    searchTag: jest.fn(async () => ({ available: false, tagObject: { publicData: { ...record } } })),
}));
jest.mock("../../Repositories/ZelfID/modules/my-zelf-id.module", () => ({
    addDurationToTag: jest.fn(async (params) => {
        await new Promise((r) => setTimeout(r, 5));
        Object.assign(record, { eventID: params.eventID, plan: params.plan });
        return { expiresAt: "2027-10-13 00:00:00" };
    }),
    revertZelfIdToFreePlan: jest.fn(),
    changeZelfIdPlan: jest.fn(),
}));
jest.mock("../../Repositories/ZelfID/modules/zelf-ids-revenue-cat-transactions.module", () => ({
    findByOriginalTransactionId: jest.fn(async () => null),
    recordTransaction: jest.fn(async () => undefined),
}));
jest.mock("../../Repositories/Tags/modules/tag-smart-contract-payment.module", () => ({
    throwPaymentConfirmationTagNotFound: jest.fn(() => {
        throw new Error("404:tag_not_found");
    }),
}));

const { addDurationToTag } = require("../../Repositories/ZelfID/modules/my-zelf-id.module");
const Model = require("../../Repositories/ZelfID/models/revenue-cat-processed-event.model");
const Events = require("../../Repositories/ZelfID/modules/zelf-ids-revenue-cat-events.module");
const { webhookHandler } = require("../../Repositories/ZelfID/modules/zelf-ids-revenue-cat.module");

const OWNER = "0xabc0000000000000000000000000000000000001";
const ev = (id, overrides = {}) => ({
    type: "NON_RENEWING_PURCHASE",
    id,
    product_id: "zelf_premium_2y",
    transaction_id: `tx_${id}`,
    original_transaction_id: `tx_${id}`,
    environment: "PRODUCTION",
    price: 43.49,
    purchased_at_ms: Date.now(),
    subscriber_attributes: { zelfName: { value: "alicebob.zelf" }, ethAddress: { value: OWNER } },
    ...overrides,
});

beforeEach(() => {
    docs.clear();
    for (const key of Object.keys(record)) delete record[key];
    Object.assign(record, { tagName: "alicebob.zelf", ethAddress: OWNER, plan: "free" });
    jest.clearAllMocks();
});

describe("RevenueCat event-id dedupe", () => {
    test("two simultaneous deliveries of one event credit exactly once", async () => {
        const [a, b] = await Promise.all([webhookHandler(ev("evt_c")), webhookHandler(ev("evt_c"))]);
        expect(addDurationToTag).toHaveBeenCalledTimes(1);
        const statuses = [a, b].map((r) => r.ignored || r.action).sort();
        expect(statuses).toEqual(["duplicate_event", "zelf_id_lease_extended"]);
        expect(docs.get("evt_c")).toMatchObject({ status: "processed", result: { status: "success", action: "zelf_id_lease_extended" } });
        expect(docs.get("evt_c").processedAt).toBeInstanceOf(Date);
    });

    test("a failed credit releases the claim so the retry credits", async () => {
        addDurationToTag.mockRejectedValueOnce(new Error("503:ipfs_unavailable"));
        await expect(webhookHandler(ev("evt_f"))).rejects.toThrow("ipfs_unavailable");
        expect(docs.has("evt_f")).toBe(false);

        const retry = await webhookHandler(ev("evt_f"));
        expect(retry.action).toBe("zelf_id_lease_extended");
        expect(addDurationToTag).toHaveBeenCalledTimes(2);
    });

    test("an old duplicate arriving after a later event is ignored (record eventID moved on)", async () => {
        await webhookHandler(ev("evt_old"));
        await webhookHandler(ev("evt_new", { product_id: "zelf_premium_3y" }));
        expect(record.eventID).toBe("evt_new");

        const late = await webhookHandler(ev("evt_old"));
        expect(late).toMatchObject({ ignored: "duplicate_event", confirmed: false });
        expect(addDurationToTag).toHaveBeenCalledTimes(2);
    });

    test("a permanent 409 does not leave a claim behind", async () => {
        await expect(webhookHandler(ev("evt_bad", { subscriber_attributes: { zelfName: { value: "abc.zelf" }, ethAddress: { value: OWNER } } }))).rejects.toThrow(
            "plan_not_allowed_for_name"
        );
        expect(Model.create).not.toHaveBeenCalled();
    });

    test("skipped events (sandbox, unhandled) never claim", async () => {
        const out = await webhookHandler(ev("evt_sb", { environment: "SANDBOX" }));
        expect(out).toMatchObject({ status: "skipped", reason: "sandbox_event" });
        expect(Model.create).not.toHaveBeenCalled();
    });

    test("an abandoned processing claim can be taken over; an in-flight one cannot", async () => {
        docs.set("evt_s", { eventId: "evt_s", status: "processing", claimedAt: new Date(Date.now() - Events.STALE_CLAIM_MS - 1000) });
        expect(await Events.claimEvent({ eventId: "evt_s" })).toBe(true);
        docs.set("evt_live", { eventId: "evt_live", status: "processing", claimedAt: new Date() });
        expect(await Events.claimEvent({ eventId: "evt_live" })).toBe(false);
    });

    test("non-duplicate DB errors propagate (RevenueCat retries)", async () => {
        Model.create.mockRejectedValueOnce(new Error("connection lost"));
        await expect(webhookHandler(ev("evt_db"))).rejects.toThrow("connection lost");
        expect(addDurationToTag).not.toHaveBeenCalled();
    });

    test("ensureIndexes builds the unique index explicitly", async () => {
        await Events.ensureIndexes();
        expect(Model.createIndexes).toHaveBeenCalled();
    });
});
