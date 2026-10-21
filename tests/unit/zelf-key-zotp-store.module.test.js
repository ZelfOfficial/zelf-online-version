jest.mock("../../Repositories/Tags/modules/tags.module", () => ({
    decryptTag: jest.fn(),
}));

const ZelfKeyModule = require("../../Repositories/ZelfKeys/modules/zelf-key.module");

const authToken = { tagName: "alice", identifier: "alice", domain: "zelf" };

const expectAllPublicDataValuesAreStrings = (publicData) => {
    for (const [key, value] of Object.entries(publicData)) {
        expect(typeof value).toBe("string");
    }
};

describe("ZelfKeys zOTP store publicData (ZelfProof encrypt contract)", () => {
    it("uses string cleartext values for default TOTP params (no client params)", async () => {
        const { publicData } = await ZelfKeyModule.createMetadataAndPublicData(
            "zotp",
            {
                username: "user@zelf.world",
                setupKey: "JBSWY3DPEHPK3PXP",
                issuer: "GitHub",
            },
            authToken
        );

        expectAllPublicDataValuesAreStrings(publicData);
        expect(publicData).toMatchObject({
            type: "zotp",
            algorithm: "SHA1",
            digits: "6",
            period: "30",
            v: "4",
        });
    });

    it("uses string cleartext values for explicit SHA256 / 8 / 60", async () => {
        const { publicData } = await ZelfKeyModule.createMetadataAndPublicData(
            "zotp",
            {
                username: "user@zelf.world",
                setupKey: "JBSWY3DPEHPK3PXP",
                issuer: "GitHub",
                algorithm: "SHA256",
                digits: 8,
                period: 60,
            },
            authToken
        );

        expectAllPublicDataValuesAreStrings(publicData);
        expect(publicData).toMatchObject({
            algorithm: "SHA256",
            digits: "8",
            period: "60",
        });
    });
});
