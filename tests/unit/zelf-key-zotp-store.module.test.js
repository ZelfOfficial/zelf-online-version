jest.mock("../../Repositories/Tags/modules/tags.module", () => ({
    decryptTag: jest.fn(),
}));

const ZelfKeyModule = require("../../Repositories/ZelfKeys/modules/zelf-key.module");
const {
    PINATA_MAX_KEYVALUES_PER_PIN,
    buildZotpStorePinKeyvaluePayloads,
    countPinKeyvalues,
} = require("../../Repositories/ZelfKeys/modules/zelf-key-zotp.module");

const authToken = { tagName: "alice", identifier: "alice", domain: "zelf" };

const expectAllPublicDataValuesAreStrings = (publicData) => {
    for (const value of Object.values(publicData)) {
        expect(typeof value).toBe("string");
    }
};

const expectPinPayloadsWithinLimit = (publicData, options = {}) => {
    const payloads = buildZotpStorePinKeyvaluePayloads(publicData, options);

    for (const payload of Object.values(payloads)) {
        expect(countPinKeyvalues(payload)).toBeLessThanOrEqual(PINATA_MAX_KEYVALUES_PER_PIN);
    }
};

describe("ZelfKeys zOTP store payloads", () => {
    it("keeps TOTP params in encrypted metadata, not public pin keyvalues (defaults)", async () => {
        const { metadata, publicData } = await ZelfKeyModule.createMetadataAndPublicData(
            "zotp",
            {
                username: "user@zelf.world",
                setupKey: "JBSWY3DPEHPK3PXP",
                issuer: "GitHub",
            },
            authToken
        );

        expectAllPublicDataValuesAreStrings(publicData);
        expect(publicData).not.toHaveProperty("algorithm");
        expect(publicData).not.toHaveProperty("digits");
        expect(publicData).not.toHaveProperty("period");
        expect(metadata).toMatchObject({
            algorithm: "SHA1",
            digits: "6",
            period: "30",
        });

        expectPinPayloadsWithinLimit(publicData, {
            identifier: "alice.zelf_123456",
            walrusBlobId: "walrus-blob-id",
        });
    });

    it("keeps TOTP params in metadata for explicit SHA256 / 8 / 60 and stays within Pinata limits", async () => {
        const { metadata, publicData } = await ZelfKeyModule.createMetadataAndPublicData(
            "zotp",
            {
                username: "user@zelf.world",
                setupKey: "JBSWY3DPEHPK3PXP",
                issuer: "GitHub",
                algorithm: "SHA256",
                digits: 8,
                period: 60,
                folder: "Work",
            },
            authToken
        );

        expect(publicData).not.toHaveProperty("algorithm");
        expect(metadata).toMatchObject({
            algorithm: "SHA256",
            digits: "8",
            period: "60",
        });
        expect(publicData.folder).toBe("Work");

        expectPinPayloadsWithinLimit(publicData, {
            identifier: "alice.zelf_123456",
            walrusBlobId: "walrus-blob-id",
        });
    });
});
