jest.mock("../../Repositories/ZelfProof/modules/zelf-proof.module", () => ({
    preview: jest.fn(),
}));

jest.mock("../../Repositories/ZelfID/modules/zelf-ids-offline.module", () => ({
    leaseOffline: jest.fn(),
}));

jest.mock("../../Repositories/Tags/modules/tags.module", () => ({
    _findDuplicatedTag: jest.fn(),
    _validateReferral: jest.fn(async () => null),
    previewZelfProof: jest.fn(),
    searchTag: jest.fn(),
}));

jest.mock("../../Repositories/Tags/modules/tags-parts.module", () => ({
    decryptParams: jest.fn(async () => ({ password: "pw" })),
    getTagNameFromPublicData: jest.fn(),
}));

jest.mock("../../Repositories/Tags/config/supported-domains", () => ({
    getDomainConfig: () => ({ getTagKey: () => "tagName", name: "zelf", getPrice: () => ({ price: 0 }) }),
}));

jest.mock("../../Repositories/Tags/modules/qr-zelfproof-extractor.module", () => ({
    extractZelfProofFromQR: jest.fn(),
    generateQRFromZelfProof: jest.fn(async () => "qr"),
}));

const ZelfProofModule = require("../../Repositories/ZelfProof/modules/zelf-proof.module");
const ZelfIdsOfflineModule = require("../../Repositories/ZelfID/modules/zelf-ids-offline.module");
const { previewZelfProof } = require("../../Repositories/Tags/modules/tags.module");
const { leaseOfflineTag } = require("../../Repositories/Tags/modules/tags-offline.module");

describe("tags-offline.module v4 dispatch shim", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    const baseParams = {
        tagName: "qa99",
        domain: "zelf",
        zelfProof: "v4-proof",
        sync: true,
        syncPublicData: { tonAddress: "EQDSMp6iTSQkQYqi9TfHLyYa-EwGdD1MH-4AQliWeII0V_8K" },
        syncPassword: "secret",
    };

    test("v4 proof with sync:true delegates to ZelfID leaseOffline", async () => {
        ZelfProofModule.preview.mockResolvedValue({
            passwordLayer: "WithoutPassword",
            publicData: { tagName: "qa99.zelf" },
        });
        ZelfIdsOfflineModule.leaseOffline.mockResolvedValue({
            sync: true,
            updated: ["ton"],
            rejected: {},
            tagObject: { publicData: { tagName: "qa99.zelf", tonAddress: "new-ton" }, origin: "offline" },
        });

        const result = await leaseOfflineTag(baseParams, {});

        expect(ZelfIdsOfflineModule.leaseOffline).toHaveBeenCalledWith(
            expect.objectContaining({
                sync: true,
                password: "pw",
                syncPassword: "secret",
            }),
            {}
        );
        expect(previewZelfProof).not.toHaveBeenCalled();
        expect(result.updated).toEqual(["ton"]);
        expect(result.publicData.tonAddress).toBe("new-ton");
    });

    test("legacy proof keeps the 3.1.6 previewZelfProof path", async () => {
        ZelfProofModule.preview.mockRejectedValue(new Error("not v4"));
        previewZelfProof.mockRejectedValue(new Error("legacy-preview-called"));

        await expect(leaseOfflineTag({ ...baseParams, sync: false, zelfProof: "legacy-proof" }, {})).rejects.toThrow(
            "legacy-preview-called"
        );

        expect(ZelfIdsOfflineModule.leaseOffline).not.toHaveBeenCalled();
        expect(previewZelfProof).toHaveBeenCalledWith({ zelfProof: "legacy-proof" }, {});
    });
});
