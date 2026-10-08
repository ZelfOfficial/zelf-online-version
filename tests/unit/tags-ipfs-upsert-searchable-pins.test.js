const pinKeyvaluesById = {};

jest.mock("../../Core/ipfs", () => ({
    updateFileKeyvalues: jest.fn(async (id, keyvalues) => {
        const snapshot = JSON.parse(JSON.stringify(keyvalues));
        pinKeyvaluesById[id] = snapshot;
        return {
            id,
            cid: "QmSameCid",
            ipfs_pin_hash: "QmSameCid",
            metadata: { keyvalues: snapshot },
        };
    }),
    getFileById: jest.fn(async (id) => ({
        id,
        cid: "QmSameCid",
        metadata: { keyvalues: JSON.parse(JSON.stringify(pinKeyvaluesById[id] || {})) },
    })),
    filter: jest.fn(async () => []),
    pinFile: jest.fn(),
    upload: jest.fn(),
    deleteFiles: jest.fn(),
}));

jest.mock("../../Repositories/Tags/config/supported-domains", () => ({
    getDomainConfig: () => ({ getTagKey: () => "tagName" }),
}));

const IPFS = require("../../Core/ipfs");
const { upsertSearchablePins } = require("../../Repositories/Tags/modules/tags-ipfs.module");
const {
    mergeAddressKeyvaluesIntoPublicData,
    buildUpsertPrimarySearchableKeyvalues,
} = require("../../Repositories/Tags/modules/tags-addresses.module");

describe("tags-ipfs upsertSearchablePins", () => {
    beforeEach(() => {
        Object.keys(pinKeyvaluesById).forEach((key) => delete pinKeyvaluesById[key]);
        IPFS.updateFileKeyvalues.mockImplementation(async (id, keyvalues) => {
            const snapshot = JSON.parse(JSON.stringify(keyvalues));
            pinKeyvaluesById[id] = snapshot;
            return {
                id,
                cid: "QmSameCid",
                ipfs_pin_hash: "QmSameCid",
                metadata: { keyvalues: snapshot },
            };
        });
        IPFS.getFileById.mockImplementation(async (id) => ({
            id,
            cid: "QmSameCid",
            metadata: { keyvalues: JSON.parse(JSON.stringify(pinKeyvaluesById[id] || {})) },
        }));
        IPFS.filter.mockResolvedValue([]);
    });

    test("packs overflow ton/aptos on the primary pin and re-reads searchable publicData", async () => {
        const addresses = {
            ethAddress: "0x0000000000000000000000000000000000000001",
            solanaAddress: "So11111111111111111111111111111111111111112",
            suiAddress: "0x0000000000000000000000000000000000000000000000000000000000000001",
            btcAddress: "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
            tonAddress: "EQDSMp6iTSQkQYqi9TfHLyYa-EwGdD1MH-4AQliWeII0V_8K",
            aptosAddress: "0x0000000000000000000000000000000000000000000000000000000000000002",
        };

        const result = await upsertSearchablePins(
            {
                base64: "data:image/png;base64,abc",
                name: "qa99.zelf",
                existingPrimaryPinId: "pin-existing",
                reserved: {
                    tagName: "qa99.zelf",
                    type: "mainnet",
                    hasPassword: "false",
                    domain: "zelf",
                    extraParams: JSON.stringify({ v: 4 }),
                },
                addresses,
                pinIt: true,
            },
            { pro: true }
        );

        expect(IPFS.updateFileKeyvalues).toHaveBeenCalledWith("pin-existing", expect.any(Object));
        expect(pinKeyvaluesById["pin-existing"]).toBeDefined();
        const primaryKeyvalues = pinKeyvaluesById["pin-existing"];
        const expectedPacked = buildUpsertPrimarySearchableKeyvalues(
            {
                tagName: "qa99.zelf",
                type: "mainnet",
                hasPassword: "false",
                domain: "zelf",
                extraParams: JSON.stringify({ v: 4 }),
            },
            addresses
        );
        expect(primaryKeyvalues.addresses || primaryKeyvalues.addresses2).toEqual(
            expectedPacked.addresses || expectedPacked.addresses2
        );
        expect(IPFS.pinFile).not.toHaveBeenCalled();

        const expanded = { ...primaryKeyvalues };
        mergeAddressKeyvaluesIntoPublicData(expanded);
        expect(expanded.tonAddress).toBe(addresses.tonAddress);
        expect(expanded.aptosAddress).toBe(addresses.aptosAddress);

        expect(result.publicData.tonAddress).toBe(addresses.tonAddress);
        expect(result.publicData.aptosAddress).toBe(addresses.aptosAddress);
        expect(IPFS.getFileById).toHaveBeenCalledWith("pin-existing");
    });
});
