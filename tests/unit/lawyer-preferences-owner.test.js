jest.mock("../../Repositories/IPFS/modules/ipfs.module", () => ({
    get: jest.fn(),
    insert: jest.fn(),
    unPinFiles: jest.fn(),
}));

jest.mock("axios", () => {
    const actual = jest.requireActual("axios");
    return { ...actual, get: jest.fn() };
});

const IPFS = require("../../Repositories/IPFS/modules/ipfs.module");
const { setPreferred } = require("../../Repositories/Lawyer/modules/lawyer.module");

beforeEach(() => {
    jest.clearAllMocks();
    IPFS.get.mockResolvedValue([]);
    IPFS.insert.mockResolvedValue({ cid: "cid-prefs" });
});

describe("lawyer preferences owner", () => {
    test("rejects a missing owner and does not write a record", async () => {
        await expect(setPreferred({ domain: "zelf", preferredLawyerZelfNames: ["ana.zelf"] }, {})).rejects.toMatchObject({
            status: 400,
            code: "OWNER_REQUIRED",
        });
        expect(IPFS.insert).not.toHaveBeenCalled();
    });

    test("rejects a domain the caller does not control", async () => {
        await expect(
            setPreferred({ domain: "other", preferredLawyerZelfNames: ["ana.zelf"] }, { email: "law@client.test", domain: "zelf" })
        ).rejects.toMatchObject({ status: 403, code: "OWNER_REQUIRED" });
        expect(IPFS.insert).not.toHaveBeenCalled();
    });

    test("writes the preference for the authenticated owner", async () => {
        const result = await setPreferred(
            { domain: "zelf", preferredLawyerZelfNames: ["ana.zelf"] },
            { email: "law@client.test", domain: "zelf" }
        );

        expect(result.success).toBe(true);
        expect(IPFS.insert).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    preferencesOwner: "law@client.test",
                    preferencesDomain: "zelf",
                }),
                name: "law@client.test.lawyer-preferences",
            }),
            { pro: true }
        );
    });
});
