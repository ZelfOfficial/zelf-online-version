jest.mock("../../Repositories/Tags/modules/tags.module", () => ({
    decryptTag: jest.fn(),
}));

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const ZelfKeyModule = require("../../Repositories/ZelfKeys/modules/zelf-key.module");
const { withZotpTotpDefaults } = require("../../Repositories/ZelfKeys/modules/zelf-key-zotp.module");

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

    it("builds encrypt-safe publicData and parses TOTP params for clients", async () => {
        const { publicData } = await ZelfKeyModule.createMetadataAndPublicData(
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

        expect(withZotpTotpDefaults(publicData)).toMatchObject({
            algorithm: "SHA1",
            digits: 6,
            period: 30,
        });
    });

    it("defaults legacy list rows that omit TOTP fields", async () => {
        const legacyRow = {
            type: "zotp",
            issuer: "GitHub",
            category: "bob.zelf_zotp",
            v: "4",
        };

        expect(withZotpTotpDefaults(legacyRow)).toMatchObject({
            algorithm: "SHA1",
            digits: 6,
            period: 30,
        });
    });
});
