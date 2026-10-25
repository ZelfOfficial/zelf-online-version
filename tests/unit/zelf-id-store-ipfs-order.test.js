/**
 * A pin that fails the 250-character keyvalue guard must not unpin or delete the name first.
 */
jest.mock("../../Repositories/Tags/modules/tags-ipfs.module", () => ({
    unpinContinuationSiblings: jest.fn(async () => null),
    deleteFiles: jest.fn(async () => null),
    insertSearchablePins: jest.fn(async () => ({ id: "new-pin" })),
    updateSearchablePinKeyvalues: jest.fn(async (id, keyvalues) => ({ id, keyvalues, publicData: { plan: "premium" } })),
    listContinuationSiblingPinIds: jest.fn(async () => ["old-sibling"]),
}));

const TagsIpfsModule = require("../../Repositories/Tags/modules/tags-ipfs.module");
const { storeInIPFS } = require("../../Repositories/ZelfID/modules/zelf-ids-payment.module");

const tag = (ipfsId = "old-pin") => ({
    fullTagName: "alice.zelf",
    ipfsId,
    id: ipfsId,
    zelfProofQRCode: "qr",
    publicData: { ethAddress: "0xabc", solanaAddress: "sol" },
});

describe("storeInIPFS pin order", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test("a rejected keyvalue does not delete or unpin the existing pin", async () => {
        const metadata = {
            tagName: "alice.zelf",
            domain: "zelf",
            extraParams: "x".repeat(251),
        };

        await expect(storeInIPFS(tag(), {}, metadata)).rejects.toMatchObject({
            clientCode: "stored_metadata_too_long",
        });

        expect(TagsIpfsModule.unpinContinuationSiblings).not.toHaveBeenCalled();
        expect(TagsIpfsModule.deleteFiles).not.toHaveBeenCalled();
        expect(TagsIpfsModule.insertSearchablePins).not.toHaveBeenCalled();
        expect(TagsIpfsModule.listContinuationSiblingPinIds).not.toHaveBeenCalled();
    });

    test("the new pin is created before the old pins are deleted", async () => {
        const order = [];
        TagsIpfsModule.listContinuationSiblingPinIds.mockImplementation(async () => {
            order.push("list");
            return ["old-sibling"];
        });
        TagsIpfsModule.insertSearchablePins.mockImplementation(async () => {
            order.push("insert");
            expect(TagsIpfsModule.deleteFiles).not.toHaveBeenCalled();
            return { id: "new-pin" };
        });
        TagsIpfsModule.deleteFiles.mockImplementation(async () => {
            order.push("delete");
        });

        const record = tag();
        await storeInIPFS(
            record,
            {},
            {
                tagName: "alice.zelf",
                domain: "zelf",
                extraParams: JSON.stringify({ plan: "premium", duration: "1" }),
            }
        );

        expect(order).toEqual(["list", "insert", "delete"]);
        expect(TagsIpfsModule.unpinContinuationSiblings).not.toHaveBeenCalled();
        expect(TagsIpfsModule.updateSearchablePinKeyvalues).not.toHaveBeenCalled();
        expect(TagsIpfsModule.deleteFiles).toHaveBeenCalledWith(["old-pin", "old-sibling"]);
        expect(record.ipfsId).toBe("new-pin");
    });

    test("a duplicate upload updates keyvalues on the existing pin", async () => {
        TagsIpfsModule.insertSearchablePins.mockResolvedValue({
            id: "old-pin",
            cid: "cid-old",
            duplicated: true,
            saved: false,
            publicData: { plan: "free" },
        });
        TagsIpfsModule.updateSearchablePinKeyvalues.mockImplementation(async (id, keyvalues) => ({
            id,
            cid: "cid-old",
            publicData: { plan: "premium", extraParams: keyvalues.extraParams },
        }));

        const record = tag();
        const stored = await storeInIPFS(
            record,
            {},
            {
                tagName: "alice.zelf",
                domain: "zelf",
                extraParams: JSON.stringify({ plan: "premium", duration: "1", expiresAt: "2126-01-01 00:00:00" }),
            }
        );

        expect(TagsIpfsModule.updateSearchablePinKeyvalues).toHaveBeenCalledWith("old-pin", expect.objectContaining({ extraParams: expect.any(String) }));
        expect(TagsIpfsModule.deleteFiles).not.toHaveBeenCalled();
        expect(stored.publicData.plan).toBe("premium");
        expect(record.ipfsId).toBe("old-pin");
    });
});
