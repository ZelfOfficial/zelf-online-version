jest.mock("../../Repositories/Tags/modules/tags.module", () => ({
    decryptTag: jest.fn(),
}));

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const ZelfKeyModule = require("../../Repositories/ZelfKeys/modules/zelf-key.module");
const {
    resolveZotpTotpForRetrieve,
    buildZotpStorePinKeyvaluePayloads,
    countPinKeyvalues,
    PINATA_MAX_KEYVALUES_PER_PIN,
} = require("../../Repositories/ZelfKeys/modules/zelf-key-zotp.module");

let memoryServer;

beforeAll(async () => {
    memoryServer = await MongoMemoryServer.create();
    await mongoose.connect(memoryServer.getUri());
});

afterAll(async () => {
    await mongoose.disconnect();
    if (memoryServer) {
        await memoryServer.stop();
    }
});

describe("ZelfKeys zOTP publicData (integration, mongodb-memory-server)", () => {
    const authToken = { tagName: "bob", identifier: "bob", domain: "zelf" };

    it("stores TOTP params only in metadata and keeps Pinata keyvalues ≤ 9", async () => {
        const { metadata, publicData } = await ZelfKeyModule.createMetadataAndPublicData(
            "zotp",
            {
                username: "legacy@zelf.world",
                setupKey: "JBSWY3DPEHPK3PXP",
                issuer: "OldExtension",
            },
            authToken
        );

        for (const value of Object.values(publicData)) {
            expect(typeof value).toBe("string");
        }

        expect(publicData).not.toHaveProperty("algorithm");
        expect(metadata).toMatchObject({ algorithm: "SHA1", digits: "6", period: "30" });

        const payloads = buildZotpStorePinKeyvaluePayloads(publicData, {
            identifier: "bob.zelf_123456",
            walrusBlobId: "walrus-blob",
        });
        expect(countPinKeyvalues(payloads.saveZelfKey)).toBeLessThanOrEqual(PINATA_MAX_KEYVALUES_PER_PIN);
        expect(countPinKeyvalues(payloads.qrCode)).toBeLessThanOrEqual(PINATA_MAX_KEYVALUES_PER_PIN);

        expect(resolveZotpTotpForRetrieve(publicData, metadata)).toMatchObject({
            algorithm: "SHA1",
            digits: 6,
            period: 30,
        });
    });

    it("defaults legacy retrieve rows that omit TOTP metadata", async () => {
        const legacyPublic = {
            type: "zotp",
            issuer: "GitHub",
            category: "bob.zelf_zotp",
            v: "4",
        };
        const legacyMetadata = {
            setupKey: "JBSWY3DPEHPK3PXP",
            username: "legacy@zelf.world",
        };

        expect(resolveZotpTotpForRetrieve(legacyPublic, legacyMetadata)).toMatchObject({
            algorithm: "SHA1",
            digits: 6,
            period: 30,
        });
    });
});
