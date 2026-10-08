const { Wallet } = require("ethers");
const { addressSyncMessage } = require("../../Repositories/Tags/modules/address-sync-ownership.util");

jest.mock("../../Repositories/Tags/config/supported-domains", () => ({
    getDomainConfig: () => ({ getTagKey: () => "tagName" }),
}));

jest.mock("../../Repositories/ZelfID/modules/zelf-id.module", () => ({
    searchTag: jest.fn(),
}));

jest.mock("../../Repositories/Tags/modules/tags-ipfs.module", () => ({
    insertSearchablePins: jest.fn(async () => ({ id: "pin-new" })),
    deleteFiles: jest.fn(async () => null),
}));

jest.mock("../../Repositories/Tags/modules/tags-arweave.module", () => ({
    tagRegistration: jest.fn(async () => null),
}));

const ZelfIdModule = require("../../Repositories/ZelfID/modules/zelf-id.module");
const TagsIPFSModule = require("../../Repositories/Tags/modules/tags-ipfs.module");
const { syncAddresses } = require("../../Repositories/ZelfID/modules/zelf-ids-sync-addresses.module");
const { listSyncAddressKeys, partitionSyncAddresses } = require("../../Repositories/ZelfID/modules/zelf-ids-address-sync.module");

const owner = new Wallet("0x" + "01".repeat(32));
const VALID_TON = "EQDSMp6iTSQkQYqi9TfHLyYa-EwGdD1MH-4AQliWeII0V_8K";
const VALID_TON_B = "EQBHyu-oZVDHRYQ1-rKlGqpHy5yAqanPBirEQNMNOmfHLotW";
const VALID_BTC = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";

const buildSignedSync = async (tagName, fields, now = Date.now()) => {
    const payload = {
        ...fields,
        _syncIssuedAt: String(Math.floor(now / 1000)),
    };
    payload._syncSignature = await owner.signMessage(addressSyncMessage(tagName, payload));
    return payload;
};

const mockTagSearch = (publicDataOverrides = {}) => {
    ZelfIdModule.searchTag.mockResolvedValue({
        available: false,
        tagObject: {
            publicData: {
                tagName: "qa99.zelf",
                ethAddress: owner.address,
                tonAddress: VALID_TON,
                type: "hold",
                ...publicDataOverrides,
            },
            zelfProofQRCode: "data:image/png;base64,abc",
        },
        ipfs: [{ id: "pin-1", ipfs_pin_hash: "QmOld" }],
    });
};

describe("zelf-ids-sync-addresses.module", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test("listSyncAddressKeys ignores metadata keys", () => {
        expect(listSyncAddressKeys({ tonAddress: "x", _syncSignature: "sig" })).toEqual(["tonAddress"]);
    });

    test("partitionSyncAddresses rejects invalid addresses by network", () => {
        const { updated, rejected } = partitionSyncAddresses({
            tonAddress: VALID_TON,
            btcAddress: "not-a-btc-address",
        });
        expect(updated).toEqual(["ton"]);
        expect(rejected.bitcoin).toBe("invalid_address");
    });

    test("syncAddresses returns 409 when there are no address fields", async () => {
        await expect(
            syncAddresses(
                {
                    tagName: "qa99",
                    domain: "zelf",
                    syncPublicData: { _syncSignature: "x", _syncIssuedAt: "1" },
                },
                {}
            )
        ).rejects.toMatchObject({ message: "409:no_addresses_to_sync", status: 409 });
    });

    test("syncAddresses returns 404 when the name is not registered", async () => {
        ZelfIdModule.searchTag.mockResolvedValue({ available: true });
        const syncPublicData = await buildSignedSync("qa99.zelf", { tonAddress: VALID_TON_B });

        await expect(
            syncAddresses({ tagName: "qa99", domain: "zelf", syncPublicData }, {})
        ).rejects.toMatchObject({ message: "404:tag_not_found", status: 404 });
    });

    test("syncAddresses returns 401 when the signature is invalid", async () => {
        mockTagSearch();
        const syncPublicData = await buildSignedSync("qa99.zelf", { tonAddress: VALID_TON_B });
        syncPublicData._syncSignature = "0x" + "11".repeat(65);

        await expect(
            syncAddresses({ tagName: "qa99", domain: "zelf", syncPublicData }, {})
        ).rejects.toMatchObject({ message: "401:invalid_sync_ownership", status: 401 });
    });

    test("syncAddresses returns 401 when the signature is expired", async () => {
        mockTagSearch();
        const expiredAt = Date.now() - 301_000;
        const syncPublicData = await buildSignedSync("qa99.zelf", { tonAddress: VALID_TON_B }, expiredAt);

        await expect(
            syncAddresses({ tagName: "qa99", domain: "zelf", syncPublicData }, {})
        ).rejects.toMatchObject({ message: "401:invalid_sync_ownership", status: 401 });
    });

    test("syncAddresses applies valid fields and reports partial rejection", async () => {
        mockTagSearch();
        const syncPublicData = await buildSignedSync("qa99.zelf", {
            tonAddress: VALID_TON_B,
            btcAddress: "bad-btc",
        });

        const result = await syncAddresses({ tagName: "qa99", domain: "zelf", syncPublicData }, {});

        expect(result.updated).toEqual(["ton"]);
        expect(result.rejected).toEqual({ bitcoin: "invalid_address" });
        expect(TagsIPFSModule.insertSearchablePins).toHaveBeenCalled();
        const addresses = TagsIPFSModule.insertSearchablePins.mock.calls[0][0].addresses;
        expect(addresses.tonAddress).toBe(VALID_TON_B);
    });

    test("syncAddresses overwrites TON and repins", async () => {
        mockTagSearch({ tonAddress: VALID_TON });
        const syncPublicData = await buildSignedSync("qa99.zelf", { tonAddress: VALID_TON_B });

        const result = await syncAddresses({ tagName: "qa99", domain: "zelf", syncPublicData }, {});

        expect(result.updated).toEqual(["ton"]);
        const addresses = TagsIPFSModule.insertSearchablePins.mock.calls[0][0].addresses;
        expect(addresses.tonAddress).toBe(VALID_TON_B);
    });

    test("syncAddresses succeeds for a valid signature and multiple addresses", async () => {
        mockTagSearch();
        const syncPublicData = await buildSignedSync("qa99.zelf", {
            tonAddress: VALID_TON_B,
            btcAddress: VALID_BTC,
        });

        const result = await syncAddresses({ tagName: "qa99", domain: "zelf", syncPublicData }, {});

        expect(result.updated.sort()).toEqual(["bitcoin", "ton"].sort());
        expect(result.rejected).toEqual({});
    });
});
