const mockAxiosGet = jest.fn();
jest.mock("../../Core/axios", () => ({ getEncryptionInstance: () => ({ get: (...a) => mockAxiosGet(...a) }) }));
jest.mock("../../Repositories/IPFS/modules/ipfs.module", () => ({ get: jest.fn(), insert: jest.fn() }));
jest.mock("../../Repositories/Client/modules/client.module", () => ({ getByStaffEmail: jest.fn(), get: jest.fn() }));
jest.mock("../../Repositories/ZelfProof/modules/zelf-proof.module", () => ({ decrypt: jest.fn(async () => ({})) }));
jest.mock("../../Repositories/Tags/modules/tags-ipfs.module", () => ({ unPinFiles: jest.fn(async () => ({})) }));

const IPFS = require("../../Repositories/IPFS/modules/ipfs.module");
const ClientModule = require("../../Repositories/Client/modules/client.module");
const TagsIPFSModule = require("../../Repositories/Tags/modules/tags-ipfs.module");
const { createOrUpdateLicense } = require("../../Repositories/License/modules/license.module");

const OWNER = "miguel@zelf.world";
const STAFF = "jim@mg.zelf.world";
const OLD_ID = "old-license-id";

const liveLicense = () => ({
    name: "zelf",
    owner: OWNER,
    zelfProof: "OWNER_PROOF",
    type: "official",
    subscriptionId: "free",
    tags: { payment: { pricingTable: { "6-15": { 1: 24 } }, planPricing: { premium: { "6-15": { 1: 28 } } } } },
});

const licenseRecord = () => ({
    id: OLD_ID,
    cid: "bafy-old",
    url: "https://ipfs/old",
    publicData: { type: "license", licenseDomain: "zelf", licenseOwner: OWNER, domain: "zelf" },
});

const setup = () => {
    jest.clearAllMocks();
    ClientModule.getByStaffEmail.mockResolvedValue({ url: "https://ipfs/staff", publicData: { staffOwnerEmail: OWNER } });
    ClientModule.get.mockResolvedValue({ publicData: { accountEmail: OWNER } });
    mockAxiosGet.mockImplementation(async (url) => {
        if (url === "https://ipfs/staff") return { data: { zelfProof: "STAFF_PROOF", ownerEmail: OWNER } };
        if (url === "https://ipfs/old") return { data: liveLicense() };
        throw new Error(`unexpected ${url}`);
    });
    IPFS.get.mockImplementation(async ({ key }) => (key === "licenseOwner" || key === "licenseDomain" ? [licenseRecord()] : []));
    IPFS.insert.mockResolvedValue({ id: "new-license-id", cid: "bafy-new", url: "https://ipfs/new" });
};

const staffJwt = { email: STAFF, ownerEmail: OWNER, accountType: "staff", role: "admin" };
const body = () => {
    const domainConfig = liveLicense();
    domainConfig.tags.payment.planPricing = { premium: { "6-15": { 1: 29 } } };
    delete domainConfig.owner;
    delete domainConfig.zelfProof;
    return { domain: "zelf", faceBase64: "AAAA", masterPassword: "x", domainConfig };
};

const insertedJson = () => JSON.parse(Buffer.from(IPFS.insert.mock.calls[0][0].base64, "base64").toString());

describe("createOrUpdateLicense as staff", () => {
    beforeEach(setup);

    test("keeps the org owner and owner proof; never stamps staff email or staff proof", async () => {
        const result = await createOrUpdateLicense(body(), staffJwt);

        expect(IPFS.insert.mock.calls[0][0].metadata.licenseOwner).toBe(OWNER);
        const json = insertedJson();
        expect(json.owner).toBe(OWNER);
        expect(json.zelfProof).toBe("OWNER_PROOF");
        expect(JSON.stringify(json)).not.toContain(STAFF);
        expect(JSON.stringify(json)).not.toContain("STAFF_PROOF");
        expect(json.tags.payment.planPricing.premium["6-15"][1]).toBe(29);
        expect(result.owner).toBe(OWNER);
    });

    test("unpins the previous license only after the new one is pinned", async () => {
        // The previous test's save seeded the read cache, so the previous license is its upload.
        IPFS.insert.mockResolvedValue({ id: "newer-license-id", cid: "bafy-newer", url: "https://ipfs/newer" });
        await createOrUpdateLicense(body(), staffJwt);
        expect(TagsIPFSModule.unPinFiles).toHaveBeenCalledTimes(1);
        expect(TagsIPFSModule.unPinFiles.mock.calls[0][0][0]).not.toBe("newer-license-id");
        expect(IPFS.insert.mock.invocationCallOrder[0]).toBeLessThan(TagsIPFSModule.unPinFiles.mock.invocationCallOrder[0]);
    });

    test("a failed upload keeps the old license pinned", async () => {
        IPFS.insert.mockRejectedValue(new Error("pinata down"));
        await expect(createOrUpdateLicense(body(), staffJwt)).rejects.toThrow("pinata down");
        expect(TagsIPFSModule.unPinFiles).not.toHaveBeenCalled();
    });

    test("staff cannot create a license when the org has none", async () => {
        IPFS.get.mockResolvedValue([]);
        await expect(createOrUpdateLicense(body(), staffJwt)).rejects.toThrow("403:staff_cannot_create_license");
        expect(IPFS.insert).not.toHaveBeenCalled();
    });
});
