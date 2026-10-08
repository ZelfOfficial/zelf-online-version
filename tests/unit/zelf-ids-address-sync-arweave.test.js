jest.mock("../../Repositories/Tags/config/supported-domains", () => ({
    getDomainConfig: () => ({
        getTagKey: () => "tagName",
        isArweaveEnabled: () => true,
    }),
}));

jest.mock("../../Repositories/Tags/modules/tags-ipfs.module", () => ({
    upsertSearchablePins: jest.fn(async () => ({ id: "pin-1", publicData: {} })),
    deleteFiles: jest.fn(),
}));

jest.mock("../../Repositories/Tags/modules/tags-arweave.module", () => ({
    tagRegistration: jest.fn(async () => {
        const error = new Error("Payment Required");
        error.status = 402;
        throw error;
    }),
}));

const { repinOfflineAddressSync } = require("../../Repositories/ZelfID/modules/zelf-ids-address-sync.module");
const TagsIPFSModule = require("../../Repositories/Tags/modules/tags-ipfs.module");

describe("zelf-ids-address-sync Arweave handling", () => {
    test("maps Turbo 402 to HTTP 402 after IPFS upsert succeeds", async () => {
        const tagRecord = {
            tagObject: {
                publicData: { tagName: "qa99.zelf", type: "mainnet", domain: "zelf" },
                zelfProofQRCode: "data:image/png;base64,abc",
            },
            ipfs: [{ id: "pin-1" }],
        };

        await expect(
            repinOfflineAddressSync(tagRecord, "tagName", { tonAddress: "EQDSMp6iTSQkQYqi9TfHLyYa-EwGdD1MH-4AQliWeII0V_8K" }, {
                zelfProofQRCode: "data:image/png;base64,abc",
            })
        ).rejects.toMatchObject({ message: "402:arweave_payment_required", status: 402 });

        expect(TagsIPFSModule.upsertSearchablePins).toHaveBeenCalled();
    });
});
