const pinKeyvaluesById = {};
let nextPinSeq = 1;

jest.mock("../../Core/ipfs", () => ({
    updateFileKeyvalues: jest.fn(async (id, keyvalues) => {
        const merged = { ...(pinKeyvaluesById[id] || {}) };
        for (const [k, v] of Object.entries(keyvalues)) {
            if (v === null) delete merged[k];
            else merged[k] = v;
        }
        pinKeyvaluesById[id] = merged;
        return {
            id,
            cid: "QmSameCid",
            ipfs_pin_hash: "QmSameCid",
            metadata: { keyvalues: JSON.parse(JSON.stringify(merged)) },
        };
    }),
    getFileById: jest.fn(async (id) => ({
        id,
        cid: "QmSameCid",
        metadata: { keyvalues: JSON.parse(JSON.stringify(pinKeyvaluesById[id] || {})) },
    })),
    filter: jest.fn(async (prop, value) => {
        return Object.entries(pinKeyvaluesById)
            .filter(([, kv]) => kv[prop] === value)
            .map(([id, kv]) => ({
                id,
                cid: `QmCid_${id}`,
                ipfs_pin_hash: `QmCid_${id}`,
                metadata: { keyvalues: JSON.parse(JSON.stringify(kv)) },
            }));
    }),
    pinFile: jest.fn(async (base64, name, metadata) => {
        const id = `pin-cont-${nextPinSeq++}`;
        const snapshot = JSON.parse(JSON.stringify(metadata || {}));
        pinKeyvaluesById[id] = snapshot;
        return {
            id,
            cid: `QmCid_${id}`,
            ipfs_pin_hash: `QmCid_${id}`,
            metadata: { keyvalues: snapshot },
        };
    }),
    upload: jest.fn(),
    deleteFiles: jest.fn(),
}));

jest.mock("../../Repositories/Tags/config/supported-domains", () => ({
    getDomainConfig: () => ({ getTagKey: () => "tagName" }),
}));

const IPFS = require("../../Core/ipfs");
const { upsertSearchablePins } = require("../../Repositories/Tags/modules/tags-ipfs.module");

describe("tags-ipfs upsertSearchablePins", () => {
    beforeEach(() => {
        nextPinSeq = 1;
        Object.keys(pinKeyvaluesById).forEach((key) => delete pinKeyvaluesById[key]);
        jest.clearAllMocks();
    });

    test("stages continuation pins before updating primary and clears legacy packed keys", async () => {
        pinKeyvaluesById["pin-existing"] = {
            tagName: "qa99.zelf",
            type: "mainnet",
            hasPassword: "false",
            domain: "zelf",
            extraParams: JSON.stringify({ v: 4 }),
            ethAddress: "0x0000000000000000000000000000000000000001",
            addresses: JSON.stringify({ tonAddress: "EQold" }),
        };

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

        expect(IPFS.pinFile).toHaveBeenCalledTimes(1);
        const primaryUpdateCalls = IPFS.updateFileKeyvalues.mock.calls.filter(([id]) => id === "pin-existing");
        expect(primaryUpdateCalls.length).toBeGreaterThanOrEqual(1);
        expect(primaryUpdateCalls.some(([, kv]) => kv.addresses === null)).toBe(true);
        expect(pinKeyvaluesById["pin-existing"].addresses).toBeUndefined();
        expect(pinKeyvaluesById["pin-cont-1"]._tagName).toBe("qa99.zelf");
        expect(pinKeyvaluesById["pin-cont-1"].tonAddress || pinKeyvaluesById["pin-cont-1"].aptosAddress).toBeDefined();

        expect(result.publicData.tonAddress).toBe(addresses.tonAddress);
        expect(result.publicData.aptosAddress).toBe(addresses.aptosAddress);
    });

    test("does not modify primary pin if continuation pin write fails", async () => {
        pinKeyvaluesById["pin-existing"] = {
            tagName: "qa99.zelf",
            domain: "zelf",
            extraParams: JSON.stringify({ v: 4 }),
            addresses: JSON.stringify({ tonAddress: "EQold" }),
        };

        IPFS.pinFile.mockRejectedValueOnce(new Error("pinata_unavailable"));

        await expect(
            upsertSearchablePins(
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
                    addresses: {
                        ethAddress: "0x0000000000000000000000000000000000000001",
                        solanaAddress: "So11111111111111111111111111111111111111112",
                        suiAddress: "0x0000000000000000000000000000000000000000000000000000000000000001",
                        btcAddress: "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
                        tonAddress: "EQDSMp6iTSQkQYqi9TfHLyYa-EwGdD1MH-4AQliWeII0V_8K",
                        aptosAddress: "0x0000000000000000000000000000000000000000000000000000000000000002",
                    },
                    pinIt: true,
                },
                { pro: true }
            )
        ).rejects.toThrow("pinata_unavailable");

        expect(IPFS.updateFileKeyvalues).not.toHaveBeenCalledWith("pin-existing", expect.anything());
        expect(pinKeyvaluesById["pin-existing"].addresses).toBeDefined();
    });
});
