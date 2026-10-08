jest.mock("../../Core/ipfs", () => ({
    updateFileKeyvalues: jest.fn(async (id, keyvalues) => ({
        id,
        cid: "QmSameCid",
        ipfs_pin_hash: "QmSameCid",
        metadata: { keyvalues },
    })),
    filter: jest.fn(async () => []),
    pinFile: jest.fn(),
    upload: jest.fn(),
    deleteFiles: jest.fn(),
}));

jest.mock("../../Repositories/Tags/config/supported-domains", () => ({
    getDomainConfig: () => ({ getTagKey: () => "tagName" }),
}));

const IPFS = require("../../Core/ipfs");
const { upsertSearchablePins } = require("../../Repositories/Tags/modules/tags-ipfs.module");

describe("tags-ipfs upsertSearchablePins", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test("updates keyvalues on the existing primary pin instead of re-pinning duplicate bytes", async () => {
        const result = await upsertSearchablePins(
            {
                base64: "data:image/png;base64,abc",
                name: "qa99.zelf",
                existingPrimaryPinId: "pin-existing",
                reserved: {
                    tagName: "qa99.zelf",
                    type: "hold",
                    hasPassword: "false",
                    extraParams: "{}",
                },
                addresses: {
                    tonAddress: "EQDSMp6iTSQkQYqi9TfHLyYa-EwGdD1MH-4AQliWeII0V_8K",
                },
                pinIt: true,
            },
            { pro: true }
        );

        expect(IPFS.updateFileKeyvalues).toHaveBeenCalledWith(
            "pin-existing",
            expect.objectContaining({
                tonAddress: "EQDSMp6iTSQkQYqi9TfHLyYa-EwGdD1MH-4AQliWeII0V_8K",
            })
        );
        expect(result.id).toBe("pin-existing");
        expect(result.publicData.tonAddress).toBe("EQDSMp6iTSQkQYqi9TfHLyYa-EwGdD1MH-4AQliWeII0V_8K");
    });
});
