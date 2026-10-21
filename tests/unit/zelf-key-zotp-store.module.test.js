jest.mock("../../Repositories/Tags/modules/tags.module", () => ({
    decryptTag: jest.fn(),
}));

const { errorHandler } = require("../../Core/http-handler");
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

describe("ZelfKeys zOTP module validation (middleware bypass)", () => {
    it("returns 409 ERR_INVALID_SETUP_KEY when setupKey fails module validation", async () => {
        await expect(
            ZelfKeyModule.createMetadataAndPublicData(
                "zotp",
                {
                    username: "user@zelf.world",
                    setupKey: "not-valid!!!",
                    issuer: "GitHub",
                },
                authToken
            )
        ).rejects.toMatchObject({
            clientCode: "ERR_INVALID_SETUP_KEY",
            clientMessage: expect.stringMatching(/Base32/i),
        });

        try {
            await ZelfKeyModule.createMetadataAndPublicData(
                "zotp",
                {
                    username: "user@zelf.world",
                    setupKey: "short",
                    issuer: "GitHub",
                },
                authToken
            );
        } catch (error) {
            const handled = errorHandler(error);
            expect(handled.status).toBe(409);
            expect(handled.code).toBe("ERR_INVALID_SETUP_KEY");
        }
    });

    it("returns 409 ERR_INVALID_TOTP_PARAMS when TOTP params fail module validation", async () => {
        try {
            await ZelfKeyModule.createMetadataAndPublicData(
                "zotp",
                {
                    username: "user@zelf.world",
                    setupKey: "JBSWY3DPEHPK3PXP",
                    issuer: "GitHub",
                    digits: 9,
                },
                authToken
            );
            throw new Error("expected createMetadataAndPublicData to throw");
        } catch (error) {
            const handled = errorHandler(error);
            expect(handled.status).toBe(409);
            expect(handled.code).toBe("ERR_INVALID_TOTP_PARAMS");
            expect(handled.message).toMatch(/digits/i);
        }
    });
});

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
