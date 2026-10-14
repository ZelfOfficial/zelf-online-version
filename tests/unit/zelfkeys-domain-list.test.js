const { listDomainKeys, belongsToDomain } = require("../../Repositories/ZelfKeys/modules/zelf-key-domain.module");
const { resolveAuthorizedDomain } = require("../../Repositories/License/modules/license-domain-access.module");
const { createSwrCache } = require("../../Core/utils/swr-snapshot-cache");

const pin = (type, owner, extra = {}) => ({
    id: `${owner}-${type}-${extra.n || 0}`,
    created_at: extra.created || "2026-10-01T00:00:00Z",
    url: "https://gateway/ipfs/SECRET_QR",
    publicData: { type, keyOwner: owner, category: `${owner}_${type}`, website: extra.website, protection: "face" },
});

const IPFS = {
    filter: jest.fn(async (prop, value) => {
        if (prop !== "type") return [];
        const all = [
            pin("password", "alice.zelf", { website: "github.com", n: 1, created: "2026-10-03T00:00:00Z" }),
            pin("password", "bob.zelf", { website: "gmail.com", n: 2, created: "2026-10-02T00:00:00Z" }),
            pin("password", "carol.bdag", { website: "x.com", n: 3 }),
            pin("notes", "alice.zelf", { n: 4 }),
            { id: "spoof", publicData: { type: "password", keyOwner: "eve.zelf", category: "other_password" } },
        ];
        return all.filter((p) => p.publicData.type === value);
    }),
};

const deps = (license) => ({
    IPFS,
    cache: createSwrCache(),
    resolveAuthorizedDomain: (jwt, d) => resolveAuthorizedDomain(jwt, d, { getMyLicense: async () => ({ myLicense: license }) }),
});
const zelfLicense = { publicData: { licenseDomain: "zelf", licenseOwner: "miguel@zelf.world" } };
const staffJwt = { accountType: "staff", email: "jim@mg.zelf.world", ownerEmail: "miguel@zelf.world" };
const ownerJwt = { accountType: "client", email: "miguel@zelf.world" };

describe("ZelfKeys domain list", () => {
    test("staff sees every key of the domain, metadata only, newest first", async () => {
        const res = await listDomainKeys({}, staffJwt, deps(zelfLicense));
        expect(res.domain).toBe("zelf");
        expect(res.domainTotal).toBe(3);
        expect(res.items.map((i) => i.owner)).toEqual(expect.arrayContaining(["alice.zelf", "bob.zelf"]));
        expect(res.items.find((i) => i.owner === "carol.bdag")).toBeUndefined();
        expect(res.items.find((i) => i.id === "spoof")).toBeUndefined();
        expect(JSON.stringify(res)).not.toContain("SECRET_QR");
        expect(res.countsByType.password).toBe(2);
        expect(res.owners).toEqual(["alice.zelf", "bob.zelf"]);
    });

    test("owner can filter by owner, type, search and paginate", async () => {
        const d = deps(zelfLicense);
        expect((await listDomainKeys({ owner: "alice" }, ownerJwt, d)).total).toBe(2);
        expect((await listDomainKeys({ type: "notes" }, ownerJwt, d)).total).toBe(1);
        expect((await listDomainKeys({ search: "gmail" }, ownerJwt, d)).items[0].owner).toBe("bob.zelf");
        const p2 = await listDomainKeys({ pageSize: "2", page: "2" }, ownerJwt, d);
        expect(p2.items).toHaveLength(1);
        expect(p2.totalPages).toBe(2);
    });

    test("rejects other domains, non-owners and staff of other licenses", async () => {
        await expect(listDomainKeys({ domain: "bdag" }, staffJwt, deps(zelfLicense))).rejects.toThrow(/^403/);
        await expect(listDomainKeys({}, { accountType: "client", email: "x@y.z" }, deps(zelfLicense))).rejects.toThrow(/^403/);
        await expect(
            listDomainKeys({}, { accountType: "staff", email: "s@x", ownerEmail: "other@x" }, deps(zelfLicense)),
        ).rejects.toThrow(/^403/);
        await expect(listDomainKeys({}, ownerJwt, deps(null))).rejects.toThrow(/^403/);
    });

    test("belongsToDomain requires matching category and domain suffix", () => {
        expect(belongsToDomain(pin("zotp", "a.zelf"), "zotp", "zelf")).toBe(true);
        expect(belongsToDomain(pin("zotp", "a.zelfpay"), "zotp", "zelf")).toBe(false);
    });
});
