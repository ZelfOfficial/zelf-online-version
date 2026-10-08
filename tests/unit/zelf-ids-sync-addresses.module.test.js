const { Wallet } = require("ethers");
const { addressSyncMessage } = require("../../Repositories/Tags/modules/address-sync-ownership.util");

jest.mock("../../Repositories/Tags/config/supported-domains", () => ({
    getDomainConfig: () => ({ getTagKey: () => "tagName" }),
}));

jest.mock("../../Repositories/ZelfID/modules/zelf-id.module", () => ({
    searchTag: jest.fn(),
}));

jest.mock("../../Repositories/Tags/modules/tags-offline.module", () => ({
    syncOfflineTagAddresses: jest.fn(async () => ({ tagName: "qa99.zelf" })),
}));

const ZelfIdModule = require("../../Repositories/ZelfID/modules/zelf-id.module");
const { syncOfflineTagAddresses } = require("../../Repositories/Tags/modules/tags-offline.module");
const {
    syncAddresses,
    partitionSyncAddresses,
    listSyncAddressKeys,
} = require("../../Repositories/ZelfID/modules/zelf-ids-sync-addresses.module");

const owner = new Wallet("0x" + "01".repeat(32));
const VALID_TON = "EQDSMp6iTSQkQYqi9TfHLyYa-EwGdD1MH-4AQliWeII0V_8K";
const VALID_BTC = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";

const buildSignedSync = async (tagName, fields, now = Date.now()) => {
    const payload = {
        ...fields,
        _syncIssuedAt: String(Math.floor(now / 1000)),
    };
    payload._syncSignature = await owner.signMessage(addressSyncMessage(tagName, payload));
    return payload;
};

const mockTagSearch = (ethAddress = owner.address) => {
    ZelfIdModule.searchTag.mockResolvedValue({
        available: false,
        tagObject: {
            publicData: { tagName: "qa99.zelf", ethAddress },
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
        const syncPublicData = await buildSignedSync("qa99.zelf", { tonAddress: VALID_TON });

        await expect(
            syncAddresses({ tagName: "qa99", domain: "zelf", syncPublicData }, {})
        ).rejects.toMatchObject({ message: "404:tag_not_found", status: 404 });
    });

    test("syncAddresses returns 401 when the signature is invalid", async () => {
        mockTagSearch();
        const syncPublicData = await buildSignedSync("qa99.zelf", { tonAddress: VALID_TON });
        syncPublicData._syncSignature = "0x" + "11".repeat(65);

        await expect(
            syncAddresses({ tagName: "qa99", domain: "zelf", syncPublicData }, {})
        ).rejects.toMatchObject({ message: "401:invalid_sync_ownership", status: 401 });
    });

    test("syncAddresses returns 401 when the signature is expired", async () => {
        mockTagSearch();
        const expiredAt = Date.now() - 301_000;
        const syncPublicData = await buildSignedSync("qa99.zelf", { tonAddress: VALID_TON }, expiredAt);

        await expect(
            syncAddresses({ tagName: "qa99", domain: "zelf", syncPublicData }, {})
        ).rejects.toMatchObject({ message: "401:invalid_sync_ownership", status: 401 });
    });

    test("syncAddresses applies valid fields and reports partial rejection", async () => {
        mockTagSearch();
        const syncPublicData = await buildSignedSync("qa99.zelf", {
            tonAddress: VALID_TON,
            btcAddress: "bad-btc",
        });

        const result = await syncAddresses({ tagName: "qa99", domain: "zelf", syncPublicData }, {});

        expect(result.updated).toEqual(["ton"]);
        expect(result.rejected).toEqual({ bitcoin: "invalid_address" });
        expect(syncOfflineTagAddresses).toHaveBeenCalledTimes(1);
        expect(syncOfflineTagAddresses.mock.calls[0][2]).toMatchObject({
            tonAddress: VALID_TON,
            _syncSignature: syncPublicData._syncSignature,
        });
        expect(syncOfflineTagAddresses.mock.calls[0][2].btcAddress).toBeUndefined();
    });

    test("syncAddresses succeeds for a valid signature and ton address", async () => {
        mockTagSearch();
        const syncPublicData = await buildSignedSync("qa99.zelf", {
            tonAddress: VALID_TON,
            btcAddress: VALID_BTC,
        });

        const result = await syncAddresses({ tagName: "qa99", domain: "zelf", syncPublicData }, {});

        expect(result.updated.sort()).toEqual(["bitcoin", "ton"].sort());
        expect(result.rejected).toEqual({});
        expect(syncOfflineTagAddresses).toHaveBeenCalled();
    });
});
