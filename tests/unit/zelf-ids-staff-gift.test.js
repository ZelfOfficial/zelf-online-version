jest.mock("../../Repositories/Tags/config/supported-domains", () => ({ getDomainConfig: jest.fn() }));
jest.mock("../../Repositories/ZelfID/modules/zelf-id.module", () => ({}));
jest.mock("../../Repositories/HumanAuthn/modules/human-authn.module", () => ({}));
jest.mock("../../Repositories/Tags/modules/qr-zelfproof-extractor.module", () => ({}));
jest.mock("../../Repositories/ZelfID/modules/zelf-id-parts.module", () => ({}));
jest.mock("../../Repositories/ZelfID/modules/zelf-ids-address-sync.module", () => ({}));
const { giftZelfId } = require("../../Repositories/ZelfID/modules/zelf-ids-staff-gift.module");
const { detectProofProvenance } = require("../../Repositories/ZelfID/modules/zelf-ids-offline.module");

const staff = { accountType: "staff", role: "write", email: "jim@x", ownerEmail: "o@x", _id: "s1" };
const licensed = (durations) => ({ licensePlanDurations: (plan) => (plan === "premium" ? durations : []) });

const deps = (over = {}) => {
    const d = {
        resolveAuthorizedDomain: jest.fn().mockResolvedValue({ domain: "bdag" }),
        getDomainConfig: () => licensed(["1", "2"]),
        ZelfIdModule: { searchTag: jest.fn().mockResolvedValue({ available: false, tagObject: { publicData: { origin: "android" }, url: "u", cid: "c" } }) },
        Offline: { leaseOffline: jest.fn().mockResolvedValue({ provenance: { version: "3", type: "offline" } }), detectProofProvenance },
        MyZelfId: { addDurationToTag: jest.fn().mockResolvedValue({ expiresAt: "2027-10-14 00:00:00" }) },
        GiftModel: { create: jest.fn() },
        ...over,
    };
    return d;
};
const body = { tagName: "bas", domain: "bdag", plan: "premium", duration: "1", reason: "r", zelfProof: "p" };

describe("staff gift", () => {
    test("rejects non-staff and read-only staff", async () => {
        await expect(giftZelfId(body, { email: "owner" }, deps())).rejects.toThrow("403:staff_only");
        await expect(giftZelfId(body, { ...staff, role: "read" }, deps())).rejects.toThrow("403:write_access_required");
    });
    test("rejects staff of another domain", async () => {
        const d = deps({ resolveAuthorizedDomain: jest.fn().mockRejectedValue(new Error("403:domain_not_managed_by_account")) });
        await expect(giftZelfId(body, staff, d)).rejects.toThrow("403:domain_not_managed_by_account");
    });
    test("refuses plan/duration missing from license", async () => {
        await expect(giftZelfId(body, staff, deps({ getDomainConfig: () => licensed([]) }))).rejects.toThrow("409:plan_not_offered_for_name");
        await expect(giftZelfId({ ...body, duration: "5" }, staff, deps())).rejects.toThrow("409:plan_duration_not_offered_by_license");
    });
    test("existing name: stamps via paid-upgrade path with price 0 gift and audits", async () => {
        const d = deps();
        const out = await giftZelfId(body, staff, d);
        expect(d.Offline.leaseOffline).not.toHaveBeenCalled();
        expect(d.MyZelfId.addDurationToTag).toHaveBeenCalledWith(expect.objectContaining({ price: 0, paymentMethod: "gift", plan: "premium", duration: 1 }), expect.anything());
        expect(d.GiftModel.create).toHaveBeenCalledWith(expect.objectContaining({ staffId: "s1", reason: "r", action: "gifted", proofType: "offline", proofVersion: "3" }));
        expect(out.expiresAt).toBe("2027-10-14 00:00:00");
    });
    test("free name: rebuilds with preserved provenance first", async () => {
        const d = deps();
        d.ZelfIdModule.searchTag.mockResolvedValueOnce({ available: true });
        const out = await giftZelfId(body, staff, d);
        expect(d.Offline.leaseOffline).toHaveBeenCalledWith(expect.objectContaining({ preserveProvenance: true, tagName: "bas.bdag" }), staff);
        expect(out.action).toBe("rebuilt_and_gifted");
    });
    test("existing name with preserveProvenance relabels from the proof", async () => {
        const d = deps();
        d.Offline.previewHumanAuthn = jest.fn().mockResolvedValue({ publicData: { origin: "android" } });
        const tagObject = { publicData: { origin: "offline", v: "4" } };
        d.ZelfIdModule.searchTag.mockResolvedValue({ available: false, tagObject });
        const out = await giftZelfId({ ...body, preserveProvenance: true }, staff, d);
        expect(out.provenance).toEqual({ version: "3", type: "offline", origin: "android" });
        expect(d.MyZelfId.addDurationToTag.mock.calls[0][1].publicData).toMatchObject({ v: "3", origin: "offline" });
    });
    test("detectProofProvenance", () => {
        expect(detectProofProvenance({ origin: "online", v: "4" })).toEqual({ version: "4", type: "online", origin: "online" });
        expect(detectProofProvenance({ origin: "android" })).toEqual({ version: "3", type: "offline", origin: "android" });
    });
});
