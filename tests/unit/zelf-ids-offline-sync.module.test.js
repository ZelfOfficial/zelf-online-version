const { Wallet } = require("ethers");
const { addressSyncMessage } = require("../../Repositories/Tags/modules/address-sync-ownership.util");

jest.mock("../../Repositories/Tags/config/supported-domains", () => ({
    getDomainConfig: () => ({ getTagKey: () => "tagName", name: "zelf" }),
}));

jest.mock("../../Repositories/HumanAuthn/modules/human-authn.module", () => ({
    preview: jest.fn(),
    decrypt: jest.fn(),
}));

jest.mock("../../Repositories/Tags/modules/qr-zelfproof-extractor.module", () => ({
    extractZelfProofFromQR: jest.fn(async () => "proof-string"),
    generateQRFromZelfProof: jest.fn(async () => "data:image/png;base64,qr"),
}));

jest.mock("../../Repositories/ZelfID/modules/zelf-id.module", () => ({
    searchTag: jest.fn(),
    _findDuplicatedTag: jest.fn(),
    _validateReferral: jest.fn(async () => null),
    persistZelfIdLease: jest.fn(),
}));

jest.mock("../../Repositories/ZelfID/modules/zelf-id-parts.module", () => ({
    decryptParams: jest.fn(async ({ password }) => ({ password })),
}));

jest.mock("../../Repositories/Tags/modules/tags-ipfs.module", () => ({
    insertSearchablePins: jest.fn(async () => ({ id: "pin-new" })),
    deleteFiles: jest.fn(async () => null),
}));

jest.mock("../../Repositories/Tags/modules/tags-arweave.module", () => ({
    tagRegistration: jest.fn(async () => null),
}));

const HumanAuthnModule = require("../../Repositories/HumanAuthn/modules/human-authn.module");
const ZelfIdModule = require("../../Repositories/ZelfID/modules/zelf-id.module");
const TagsIPFSModule = require("../../Repositories/Tags/modules/tags-ipfs.module");
const { leaseOffline } = require("../../Repositories/ZelfID/modules/zelf-ids-offline.module");

const owner = new Wallet("0x" + "01".repeat(32));
const VALID_TON = "EQDSMp6iTSQkQYqi9TfHLyYa-EwGdD1MH-4AQliWeII0V_8K";
const VALID_TON_B = "EQBHyu-oZVDHRYQ1-rKlGqpHy5yAqanPBirEQNMNOmfHLotW";

const buildSignedSync = async (tagName, fields, now = Date.now()) => {
    const payload = {
        ...fields,
        _syncIssuedAt: String(Math.floor(now / 1000)),
    };
    payload._syncSignature = await owner.signMessage(addressSyncMessage(tagName, payload));
    return payload;
};

const basePreview = () => {
    HumanAuthnModule.preview.mockResolvedValue({
        passwordLayer: "WithoutPassword",
        publicData: { tagName: "qa99.zelf", domain: "zelf", ethAddress: owner.address },
    });
};

const mockExistingTag = (overrides = {}) => {
    ZelfIdModule.searchTag.mockResolvedValue({
        available: false,
        tagObject: {
            publicData: {
                tagName: "qa99.zelf",
                ethAddress: owner.address,
                tonAddress: VALID_TON,
                type: "hold",
                ...overrides,
            },
            zelfProofQRCode: "data:image/png;base64,abc",
        },
        ipfs: [{ id: "pin-1" }],
    });
};

describe("zelf-ids-offline.module leaseOffline sync branch", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        basePreview();
    });

    const syncRequest = (syncPublicData, extra = {}) => ({
        tagName: "qa99",
        domain: "zelf",
        zelfProof: "proof-string",
        sync: true,
        syncPublicData,
        ...extra,
    });

    test("sync with signature updates TON and returns updated/rejected", async () => {
        mockExistingTag();
        const syncPublicData = await buildSignedSync("qa99.zelf", { tonAddress: VALID_TON_B });

        const result = await leaseOffline(syncRequest(syncPublicData), {});

        expect(result.sync).toBe(true);
        expect(result.updated).toEqual(["ton"]);
        expect(ZelfIdModule._findDuplicatedTag).not.toHaveBeenCalled();
        expect(TagsIPFSModule.insertSearchablePins).toHaveBeenCalled();
    });

    test("sync with password validates via Human Authn decrypt", async () => {
        mockExistingTag();
        HumanAuthnModule.decrypt.mockResolvedValue({ metadata: { mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" } });

        const result = await leaseOffline(
            syncRequest({ tonAddress: VALID_TON_B }, { syncPassword: "secret" }),
            {}
        );

        expect(result.updated).toEqual(["ton"]);
        expect(HumanAuthnModule.decrypt).toHaveBeenCalled();
    });

    test("sync returns 401 for bad signature", async () => {
        mockExistingTag();
        const syncPublicData = await buildSignedSync("qa99.zelf", { tonAddress: VALID_TON_B });
        syncPublicData._syncSignature = "0x" + "22".repeat(65);

        await expect(leaseOffline(syncRequest(syncPublicData), {})).rejects.toMatchObject({
            message: "401:invalid_sync_ownership",
            status: 401,
        });
    });

    test("sync returns 404 when the name is unknown", async () => {
        ZelfIdModule.searchTag.mockResolvedValue({ available: true });
        const syncPublicData = await buildSignedSync("qa99.zelf", { tonAddress: VALID_TON_B });

        await expect(leaseOffline(syncRequest(syncPublicData), {})).rejects.toMatchObject({
            message: "404:tag_not_found",
            status: 404,
        });
    });

    test("sync returns 409 when addresses are unchanged", async () => {
        mockExistingTag({ tonAddress: VALID_TON_B });
        const syncPublicData = await buildSignedSync("qa99.zelf", { tonAddress: VALID_TON_B });

        await expect(leaseOffline(syncRequest(syncPublicData), {})).rejects.toMatchObject({
            message: "409:no_addresses_to_sync",
            status: 409,
        });
    });

    test("sync returns 401 when password validation fails", async () => {
        mockExistingTag();
        HumanAuthnModule.decrypt.mockResolvedValue({ error: { code: "INVALID_PASSWORD" } });

        await expect(
            leaseOffline(syncRequest({ tonAddress: VALID_TON_B }, { password: "wrong" }), {})
        ).rejects.toMatchObject({ message: "401:invalid_sync_password", status: 401 });
    });
});
