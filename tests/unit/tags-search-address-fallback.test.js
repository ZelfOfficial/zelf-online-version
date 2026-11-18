/**
 * Continuation-pin lookup failures must be visible, and packed addresses that
 * are still missing afterwards come from tagaddressindexes. A successful lookup
 * keeps the address it already resolved.
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const IPFS = require("../../Core/ipfs");
const TagsIPFSModule = require("../../Repositories/Tags/modules/tags-ipfs.module");
const { searchTag } = require("../../Repositories/Tags/modules/tags-search.module");
const TagAddressIndex = require("../../Repositories/Tags/models/tag-address-index.model");

const TAG_NAME = "qa.zelf";
const DOMAIN = "zelf";
const INDEX_APTOS = "0xeb663b681209e7087d681c5d3eed12aaa8e1915e7c87794542c3f96e94b3d3bf";
const DECOY_APTOS = "0x0000000000000000000000000000000000000000000000000000000000000002";
const CONTINUATION_APTOS = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const PRIMARY_DOT = "13QEUFdyedm9SUt15yZCCJ3mejjSRqkTrh2okWZYhd388bni";
const WRONG_DOT = "5WrongDotAddressShouldNotWin000000000000000";

const domainConfig = {
    name: "zelf",
    tags: {
        storage: {
            ipfsEnabled: true,
            arweaveEnabled: false,
            keyPrefix: "tagName",
        },
    },
};

const packedAddresses = (aptosAddress) => ({
    btcAddress: "bc1qcomplete0000000000000000000000000000001",
    suiAddress: "0x1111111111111111111111111111111111111111111111111111111111111111",
    xlmAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    tonAddress: "EQDSMp6iTSQkQYqi9TfHLyYa-EwGdD1MH-4AQliWeII0V_8K",
    arweaveAddress: "arweavecompleteaddress0000000000000000000",
    dotAddress: PRIMARY_DOT,
    ksmAddress: "EyYzEinRDWbkbgvu3KEx6acwi22YD1WEa94ysr9dLE6hEAG",
    ...(aptosAddress ? { aptosAddress } : {}),
});

const pin = (publicData) => [
    {
        id: "pin-qa",
        name: TAG_NAME,
        url: "",
        publicData: {
            tagName: TAG_NAME,
            zelfName: TAG_NAME,
            domain: DOMAIN,
            ethAddress: "0x1111111111111111111111111111111111111111",
            ...publicData,
        },
    },
];

describe("tag search address hydration fallback", () => {
    let memory;

    beforeAll(async () => {
        memory = await MongoMemoryServer.create();
        if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
        await mongoose.connect(memory.getUri());
    }, 180000);

    afterAll(async () => {
        await mongoose.disconnect();
        if (memory) await memory.stop();
    });

    beforeEach(async () => {
        await TagAddressIndex.deleteMany({});
        jest.spyOn(console, "warn").mockImplementation(() => {});
        jest.spyOn(TagsIPFSModule, "get").mockResolvedValue(pin(packedAddresses()));
        jest.spyOn(IPFS, "filter").mockResolvedValue([]);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    const search = () =>
        searchTag(
            {
                tagName: TAG_NAME,
                domain: DOMAIN,
                environment: "ipfs",
                type: "mainnet",
                domainConfig,
            },
            {}
        );

    const continuationWarnings = () =>
        console.warn.mock.calls.filter((args) => args[0] === "continuation address lookup failed:");

    test("logs a continuation lookup failure and fills aptosAddress from Mongo", async () => {
        TagsIPFSModule.get.mockResolvedValue(pin(packedAddresses()));
        IPFS.filter.mockRejectedValue(new Error("pinata_unavailable"));

        await TagAddressIndex.create({ key: "aptosAddress", value: INDEX_APTOS, tagName: TAG_NAME, domain: DOMAIN });
        await TagAddressIndex.create({ key: "aptosAddress", value: DECOY_APTOS, tagName: TAG_NAME, domain: "other" });
        await TagAddressIndex.create({ key: "aptosAddress", value: DECOY_APTOS, tagName: "other.zelf", domain: DOMAIN });
        await TagAddressIndex.create({ key: "dotAddress", value: WRONG_DOT, tagName: TAG_NAME, domain: DOMAIN });

        const result = await search();

        expect(continuationWarnings()).toEqual([["continuation address lookup failed:", TAG_NAME, "pinata_unavailable"]]);
        expect(JSON.stringify(console.warn.mock.calls)).not.toContain(INDEX_APTOS);
        expect(IPFS.filter).toHaveBeenCalledTimes(2);
        expect(IPFS.filter).toHaveBeenNthCalledWith(1, "_tagName", TAG_NAME, { throwOnError: true });
        expect(IPFS.filter).toHaveBeenNthCalledWith(2, "__tagName", TAG_NAME, { throwOnError: true });
        expect(result.available).toBe(false);
        expect(result.tagName).toBe(TAG_NAME);
        expect(result.domain).toBe(DOMAIN);
        expect(result.tagObject.publicData.aptosAddress).toBe(INDEX_APTOS);
        expect(result.tagObject.publicData.dotAddress).toBe(PRIMARY_DOT);
        expect(result.tagObject.publicData.ethAddress).toBe("0x1111111111111111111111111111111111111111");
        expect(result.resolvedBy).toBeUndefined();
        expect(result.tagObject.indexedAddresses).toBeUndefined();
    });

    test("keeps the continuation address when the lookup succeeds", async () => {
        TagsIPFSModule.get.mockResolvedValue(pin(packedAddresses()));
        IPFS.filter.mockImplementation(async (key) => {
            if (key !== "_tagName") return [];
            return [
                {
                    id: "pin-cont",
                    name: `_${TAG_NAME}`,
                    publicData: { _tagName: TAG_NAME, aptosAddress: CONTINUATION_APTOS },
                },
            ];
        });
        await TagAddressIndex.create({ key: "aptosAddress", value: INDEX_APTOS, tagName: TAG_NAME, domain: DOMAIN });
        const findSpy = jest.spyOn(TagAddressIndex, "find");

        const result = await search();

        expect(continuationWarnings()).toEqual([]);
        expect(findSpy).not.toHaveBeenCalled();
        expect(IPFS.filter).toHaveBeenCalledTimes(2);
        expect(result.tagObject.publicData.aptosAddress).toBe(CONTINUATION_APTOS);
        expect(result.tagObject.publicData.dotAddress).toBe(PRIMARY_DOT);
        expect(result.available).toBe(false);
    });
});
