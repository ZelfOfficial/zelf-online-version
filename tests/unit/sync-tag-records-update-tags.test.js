jest.mock("../../Repositories/Wallet/modules/stellar", () => ({
    healPublicDataXlm: () => ({
        stellar: { address: "GMOCK", secretKey: "mock" },
        shouldPersistXlm: false,
        hadXlmBeforeHeal: false,
    }),
}));

jest.mock("../../Repositories/Tags/config/supported-domains", () => ({
    getDomainConfig: jest.fn(() => ({
        name: "zelf",
        getTagKey: () => "tagName",
        isArweaveEnabled: jest.fn(() => true),
    })),
}));

jest.mock("../../Repositories/Tags/modules/tags-ipfs.module", () => ({
    listContinuationSiblingPinIds: jest.fn(async () => []),
    upsertSearchablePins: jest.fn(async () => ({ id: "pin-primary" })),
    insertSearchablePins: jest.fn(async () => ({ id: "pin-new" })),
    unPinFiles: jest.fn(async () => null),
    unpinContinuationSiblings: jest.fn(async () => null),
}));

jest.mock("../../Repositories/Tags/modules/tags-arweave.module", () => ({
    tagRegistration: jest.fn(async () => ({ id: "arw-1" })),
}));

const { getDomainConfig } = require("../../Repositories/Tags/config/supported-domains");
const TagsIPFSModule = require("../../Repositories/Tags/modules/tags-ipfs.module");
const TagsArweaveModule = require("../../Repositories/Tags/modules/tags-arweave.module");
const { updateTags } = require("../../Repositories/Tags/modules/sync-tag-records.module");

const baseTagObject = () => ({
    id: "pin-primary",
    zelfProofQRCode: "data:image/png;base64,qr",
    publicData: {
        tagName: "qa99.zelf",
        domain: "zelf",
        type: "mainnet",
        ethAddress: "0x0000000000000000000000000000000000000001",
        v: 4,
    },
});

describe("sync-tag-records updateTags", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        getDomainConfig.mockReturnValue({
            name: "zelf",
            getTagKey: () => "tagName",
            isArweaveEnabled: jest.fn(() => true),
        });
        TagsIPFSModule.listContinuationSiblingPinIds.mockResolvedValue([]);
        TagsIPFSModule.upsertSearchablePins.mockResolvedValue({ id: "pin-primary" });
    });

    test("Arweave 402 after IPFS write does not unpin the primary pin", async () => {
        const arweaveError = new Error("402 Payment Required");
        arweaveError.status = 402;
        TagsArweaveModule.tagRegistration.mockRejectedValueOnce(arweaveError);

        const tagObject = baseTagObject();
        const result = await updateTags(tagObject, [{ name: "dotAddress", value: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" }]);

        expect(TagsIPFSModule.upsertSearchablePins).toHaveBeenCalled();
        expect(TagsIPFSModule.unPinFiles).not.toHaveBeenCalled();
        expect(result.ipfs).toEqual({ id: "pin-primary" });
    });

    test("same-id upsert does not delete the existing primary pin", async () => {
        TagsArweaveModule.tagRegistration.mockResolvedValueOnce({ id: "arw-1" });

        const tagObject = baseTagObject();
        await updateTags(tagObject, [{ name: "ksmAddress", value: "15oF4uVJwpx4kNVZgDEjDurjRforwCmzz5LnXkhLEmPYqt3FU" }]);

        expect(TagsIPFSModule.upsertSearchablePins).toHaveBeenCalledWith(
            expect.objectContaining({ existingPrimaryPinId: "pin-primary" }),
            { pro: true }
        );
        expect(TagsIPFSModule.unPinFiles).not.toHaveBeenCalled();
    });

    test("does not call Arweave when the domain gate is off", async () => {
        getDomainConfig.mockReturnValue({
            name: "zelf",
            getTagKey: () => "tagName",
            isArweaveEnabled: jest.fn(() => false),
        });

        await updateTags(baseTagObject(), [], { forceRepin: true });

        expect(TagsArweaveModule.tagRegistration).not.toHaveBeenCalled();
        expect(TagsIPFSModule.unPinFiles).not.toHaveBeenCalled();
    });

    test("does not unpin when the IPFS write throws", async () => {
        TagsIPFSModule.upsertSearchablePins.mockRejectedValueOnce(new Error("pinata_down"));

        await expect(updateTags(baseTagObject(), [{ name: "dotAddress", value: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" }])).rejects.toThrow(
            "pinata_down"
        );

        expect(TagsIPFSModule.unPinFiles).not.toHaveBeenCalled();
    });

    test("unpins stale continuation siblings after a successful write with new ids", async () => {
        TagsIPFSModule.listContinuationSiblingPinIds
            .mockResolvedValueOnce(["cont-old"])
            .mockResolvedValueOnce(["cont-new"]);
        TagsIPFSModule.upsertSearchablePins.mockResolvedValueOnce({ id: "pin-new" });

        const tagObject = { ...baseTagObject(), id: "pin-old" };
        await updateTags(tagObject, [{ name: "dotAddress", value: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" }]);

        expect(TagsIPFSModule.unPinFiles).toHaveBeenCalledWith(["pin-old", "cont-old"]);
    });
});
