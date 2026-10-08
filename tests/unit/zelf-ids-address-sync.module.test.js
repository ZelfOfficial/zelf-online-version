jest.mock("../../Repositories/ZelfID/modules/zelf-id-parts.module", () => ({
    decryptParams: jest.fn(async () => ({ face: "face-from-session", password: "correct-password" })),
}));

jest.mock("../../Repositories/HumanAuthn/modules/human-authn.module", () => ({
    decrypt: jest.fn(),
}));

jest.mock("../../Repositories/Tags/config/supported-domains", () => ({
    getDomainConfig: () => ({
        getTagKey: () => "tagName",
        isArweaveEnabled: () => false,
    }),
}));

jest.mock("../../Repositories/Tags/modules/tags-ipfs.module", () => ({
    upsertSearchablePins: jest.fn(async (data) => ({
        id: "pin-1",
        publicData: { ...(data.addresses || {}), tagName: data.name },
    })),
    deleteFiles: jest.fn(),
}));

jest.mock("../../Repositories/Tags/modules/tags-arweave.module", () => ({
    tagRegistration: jest.fn(),
}));

const HumanAuthnModule = require("../../Repositories/HumanAuthn/modules/human-authn.module");
const TagsArweaveModule = require("../../Repositories/Tags/modules/tags-arweave.module");
const {
    buildAddressSourceFromSync,
    partitionSyncAddresses,
    addressFieldsChanged,
    validateSyncPassword,
    computePersistedUpdatedNetworks,
    applyAddressSyncToRecord,
    repinOfflineAddressSync,
} = require("../../Repositories/ZelfID/modules/zelf-ids-address-sync.module");

const VALID_TON_A = "EQDSMp6iTSQkQYqi9TfHLyYa-EwGdD1MH-4AQliWeII0V_8K";
const VALID_TON_B = "EQBHyu-oZVDHRYQ1-rKlGqpHy5yAqanPBirEQNMNOmfHLotW";

describe("zelf-ids-address-sync.module", () => {
    test("buildAddressSourceFromSync overwrites an existing TON address", () => {
        const publicData = { tonAddress: VALID_TON_A, btcAddress: "bc1old" };
        const { accepted } = partitionSyncAddresses({ tonAddress: VALID_TON_B });
        const merged = buildAddressSourceFromSync(publicData, accepted);
        expect(merged.tonAddress).toBe(VALID_TON_B);
    });

    test("buildAddressSourceFromSync applies btcAddress from sync payload", () => {
        const VALID_BTC = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";
        const publicData = { tagName: "qa99.zelf" };
        const { accepted } = partitionSyncAddresses({ btcAddress: VALID_BTC });
        const merged = buildAddressSourceFromSync(publicData, accepted);
        expect(merged.btcAddress).toBe(VALID_BTC);
    });

    test("addressFieldsChanged detects TON updates", () => {
        const before = { tonAddress: VALID_TON_A };
        const { accepted } = partitionSyncAddresses({ tonAddress: VALID_TON_B });
        const after = buildAddressSourceFromSync(before, accepted);
        expect(addressFieldsChanged(before, after)).toBe(true);
    });

    test("validateSyncPassword uses session-decrypted face and password on v4 decrypt", async () => {
        HumanAuthnModule.decrypt.mockResolvedValue({ metadata: { mnemonic: "words" } });

        const ok = await validateSyncPassword(
            "proof",
            { password: "enc-password", faceBase64: "enc-face", os: "ANDROID" },
            { clientId: "test" }
        );

        expect(ok).toBe(true);
        expect(HumanAuthnModule.decrypt).toHaveBeenCalledWith(
            expect.objectContaining({
                faceBase64: "face-from-session",
                password: "correct-password",
                os: "ANDROID",
            })
        );
    });

    test("computePersistedUpdatedNetworks ignores in-memory-only changes", () => {
        const accepted = { tonAddress: "EQDSMp6iTSQkQYqi9TfHLyYa-EwGdD1MH-4AQliWeII0V_8K" };
        const before = { tonAddress: "EQDSMp6iTSQkQYqi9TfHLyYa-EwGdD1MH-4AQliWeII0V_8K" };
        const after = { tonAddress: "EQDSMp6iTSQkQYqi9TfHLyYa-EwGdD1MH-4AQliWeII0V_8K" };
        expect(computePersistedUpdatedNetworks(before, after, accepted)).toEqual([]);
    });

    test("applyAddressSyncToRecord returns 409 when persisted addresses are unchanged", async () => {
        const ton = "EQDSMp6iTSQkQYqi9TfHLyYa-EwGdD1MH-4AQliWeII0V_8K";
        const TagsIPFSModule = require("../../Repositories/Tags/modules/tags-ipfs.module");
        TagsIPFSModule.upsertSearchablePins.mockResolvedValueOnce({
            id: "pin-1",
            publicData: { tagName: "qa99.zelf", tonAddress: ton },
        });

        const tagRecord = {
            tagObject: {
                publicData: { tagName: "qa99.zelf", tonAddress: ton, ethAddress: "0x01" },
                zelfProofQRCode: "data:image/png;base64,abc",
            },
            ipfs: [{ id: "pin-1" }],
        };

        await expect(
            applyAddressSyncToRecord({
                tagRecord,
                tagKey: "tagName",
                syncPublicData: { tonAddress: ton },
                zelfProofQRCode: "data:image/png;base64,abc",
            })
        ).rejects.toMatchObject({ message: "409:no_addresses_to_sync", status: 409 });
    });

    test("repinOfflineAddressSync skips Arweave when domain gate is off", async () => {
        const tagRecord = {
            tagObject: {
                publicData: { tagName: "qa99.zelf", type: "mainnet", domain: "zelf" },
                zelfProofQRCode: "data:image/png;base64,abc",
            },
            ipfs: [{ id: "pin-1" }],
        };

        await repinOfflineAddressSync(tagRecord, "tagName", { tonAddress: VALID_TON_B }, {
            zelfProofQRCode: "data:image/png;base64,abc",
        });

        expect(TagsArweaveModule.tagRegistration).not.toHaveBeenCalled();
    });
});
