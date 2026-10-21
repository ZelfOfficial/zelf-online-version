const { getSummary, listRecords, buildSummary } = require("../../Repositories/ZelfID/modules/zelf-ids-analytics.module");
const { createSwrCache } = require("../../Core/utils/swr-snapshot-cache");

const NOW = Date.parse("2026-10-14T12:00:00Z");
const row = (name, type, registeredAt, expiresAt, extra = {}) => ({ name, publicData: { type, registeredAt, expiresAt, origin: "online", ...extra } });

const ipfsRows = [
    row("alice.zelf", "mainnet", "2026-10-13 10:00:00", "2027-10-13 10:00:00", { plan: "premium" }),
    row("bo.zelf", "mainnet", "2026-10-01 10:00:00", "2200-10-01 10:00:00", { plan: "unlimited" }),
    row("carolinelongname.zelf", "devnet", "2026-08-20 10:00:00", "2026-09-20 10:00:00"),
    row("alice.zelf", "mainnet", "2026-10-13 10:00:00", "2027-10-13 10:00:00"),
];
const makeDeps = () => {
    const TagsIPFSModule = { searchByDomain: jest.fn(async () => ipfsRows) };
    const TagsArweaveModule = { searchByDomain: jest.fn(async () => [row("dan.zelf", "mainnet", "2026-10-10 00:00:00", "2028-10-10 00:00:00")]) };
    return {
        TagsIPFSModule,
        TagsArweaveModule,
        cache: createSwrCache(),
        now: () => NOW,
        resolveAuthorizedDomain: async (jwt, d) => {
            if (d && d !== "zelf") throw new Error("403:domain_not_managed_by_account");
            return { domain: "zelf" };
        },
    };
};

describe("zelf-ids analytics", () => {
    test("summary aggregates without returning every record and loads the snapshot once", async () => {
        const deps = makeDeps();
        const s = await getSummary({}, {}, deps);
        await getSummary({}, {}, deps);
        expect(deps.TagsIPFSModule.searchByDomain).toHaveBeenCalledTimes(1);
        expect(s.totals).toMatchObject({ total: 4, paid: 3, active: 3 });
        expect(s.byStorage).toEqual({ IPFS: 3, Arweave: 1 });
        expect(s.byPlan.premium).toBe(1);
        expect(s.byLeaseYears).toMatchObject({ 1: 1, 2: 1, lifetime: 1 });
        expect(s.byNameLength["1-3"]).toBe(2);
        expect(s.daily).toHaveLength(60);
        expect(s.daily.find((d) => d.date === "2026-10-13")).toMatchObject({ all: 1, paid: 1 });
        expect(s.recent[0].name).toBe("alice.zelf");
        expect(s.recent.length).toBeLessThanOrEqual(10);
    });

    test("records drill-down filters and paginates", async () => {
        const deps = makeDeps();
        expect((await listRecords({ type: "mainnet" }, {}, deps)).total).toBe(3);
        expect((await listRecords({ status: "expired" }, {}, deps)).items[0].name).toBe("carolinelongname.zelf");
        expect((await listRecords({ storage: "Arweave" }, {}, deps)).total).toBe(1);
        expect((await listRecords({ from: "2026-10-05", to: "2026-10-31" }, {}, deps)).total).toBe(2);
        const p = await listRecords({ pageSize: "1", page: "2" }, {}, deps);
        expect(p.items).toHaveLength(1);
        expect(p.totalPages).toBe(4);
    });

    test("other domains are rejected", async () => {
        await expect(getSummary({ domain: "bdag" }, {}, makeDeps())).rejects.toThrow(/^403/);
    });

    test("arweave failure does not break the summary", async () => {
        const deps = makeDeps();
        deps.TagsArweaveModule.searchByDomain = jest.fn(async () => {
            throw new Error("down");
        });
        const s = await getSummary({}, {}, deps);
        expect(s.totals.total).toBe(3);
    });

    test("does not replace a good snapshot when IPFS returns incomplete", async () => {
        let clock = 0;
        const deps = makeDeps();
        deps.now = () => clock;
        deps.cache = createSwrCache({
            ttlMs: 1000,
            maxStaleMs: 60_000,
            now: deps.now,
            shouldPersist: (snapshot) => !snapshot?.incomplete,
        });

        const good = await getSummary({}, {}, deps);
        expect(good.totals.total).toBe(4);

        clock = 5000;
        deps.TagsIPFSModule.searchByDomain.mockImplementation(async () => ({
            rows: [row("only.zelf", "mainnet", "2026-10-14 10:00:00", "2027-10-14 10:00:00")],
            incomplete: true,
        }));

        const after = await getSummary({}, {}, deps);
        expect(deps.TagsIPFSModule.searchByDomain).toHaveBeenCalledTimes(2);
        expect(after.totals.total).toBe(4);
        expect(after.incomplete).toBeUndefined();
        expect(after.stale).toBe(true);
        expect(after.snapshotAgeSec).toBe(5);

        clock = 12_000;
        const aged = await getSummary({}, {}, deps);
        expect(aged.snapshotAgeSec).toBe(12);
        expect(aged.stale).toBe(true);
        expect(aged.totals.total).toBe(4);
    });

    test("surfaces incomplete on summary when no prior snapshot exists", async () => {
        const deps = makeDeps();
        deps.TagsArweaveModule.searchByDomain = jest.fn(async () => []);
        deps.TagsIPFSModule.searchByDomain = jest.fn(async () => ({
            rows: [row("partial.zelf", "mainnet", "2026-10-14 10:00:00", "2027-10-14 10:00:00")],
            incomplete: true,
        }));
        deps.cache = createSwrCache({ shouldPersist: (snapshot) => !snapshot?.incomplete });

        const s = await getSummary({}, {}, deps);
        expect(s.totals.total).toBe(1);
        expect(s.incomplete).toBe(true);
    });

    test("buildSummary handles empty", () => {
        expect(buildSummary([], "zelf", NOW).totals.total).toBe(0);
    });
});
