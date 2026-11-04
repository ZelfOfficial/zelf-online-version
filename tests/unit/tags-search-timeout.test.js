const TagsSearchModule = require("../../Repositories/Tags/modules/tags-search.module");
const TagsIPFSModule = require("../../Repositories/Tags/modules/tags-ipfs.module");
const TagsArweaveModule = require("../../Repositories/Tags/modules/tags-arweave.module");
const TagsPartsModule = require("../../Repositories/Tags/modules/tags-parts.module");

describe("tags-search.module - timeouts and early IPFS resolution", () => {
    const mockDomainConfig = {
        name: "zelf",
        getTagKey: () => "tagName",
        getPrice: () => ({ price: 10 }),
        tags: {
            storage: {
                ipfsEnabled: true,
                arweaveEnabled: true,
                keyPrefix: "tagName",
            },
            payment: {
                planPricing: { premium: { "6-15": { 1: 29 } }, unlimited: { "1-5": { 1: 99 }, "6-15": { 1: 99 } } },
            },
        },
    };

    beforeEach(() => {
        jest.restoreAllMocks();
    });

    it("returns IPFS results without waiting for slow Arweave when IPFS succeeds", async () => {
        const ipfsResult = [
            {
                id: "ipfs-123",
                name: "testuser.zelf",
                url: "https://ipfs.zelf.world/ipfs/QmTest",
                publicData: { tagName: "testuser.zelf", testKey: "testValue" },
            },
        ];

        // Fast IPFS response (50ms)
        jest.spyOn(TagsIPFSModule, "get").mockImplementation(async () => {
            await new Promise((r) => {
                const timer = setTimeout(r, 50);
                timer.unref();
            });
            return ipfsResult;
        });

        // Slow Arweave response (2000ms - simulating slow gateway)
        jest.spyOn(TagsArweaveModule, "searchByStorageKey").mockImplementation(async () => {
            await new Promise((r) => {
                const timer = setTimeout(r, 2000);
                timer.unref();
            });
            return [
                {
                    id: "ar-123",
                    url: "https://arweave.net/tx123",
                    publicData: { tagName: "testuser.zelf" },
                },
            ];
        });

        jest.spyOn(TagsPartsModule, "urlToBase64First").mockResolvedValue("data:image/png;base64,mockqr");

        const start = Date.now();
        const result = await TagsSearchModule.searchTag({
            tagName: "testuser.zelf",
            domain: "zelf",
            domainConfig: mockDomainConfig,
            environment: "all",
            type: "both",
        });
        const elapsed = Date.now() - start;

        // Must finish well before the 3000ms Arweave delay
        expect(elapsed).toBeLessThan(1500);
        expect(result.available).toBe(false);
        expect(result.ipfs).toHaveLength(1);
        expect(result.tagObject).toBeDefined();
        expect(result.tagObject.ipfsId).toBe("ipfs-123");
    });

    it("properly assigns tagObject from IPFS as canonical source, enriching with Arweave when both respond", async () => {
        const ipfsResult = [
            {
                id: "ipfs-canonical",
                name: "canonical.zelf",
                url: "https://ipfs.zelf.world/ipfs/QmCanonical",
                cid: "QmCanonical",
                publicData: { tagName: "canonical.zelf", ipfsField: "ipfsValue", sharedField: "fromIPFS" },
            },
        ];
        const arweaveResult = [
            {
                id: "ar-tx-supplementary",
                url: "https://arweave.net/txSupplementary",
                publicData: { tagName: "canonical.zelf", arweaveField: "arValue", sharedField: "fromArweave" },
            },
        ];

        jest.spyOn(TagsIPFSModule, "get").mockResolvedValue(ipfsResult);
        jest.spyOn(TagsArweaveModule, "searchByStorageKey").mockResolvedValue(arweaveResult);
        jest.spyOn(TagsPartsModule, "urlToBase64First").mockResolvedValue("data:image/png;base64,mockqr");

        const result = await TagsSearchModule.searchTag({
            tagName: "canonical.zelf",
            domain: "zelf",
            domainConfig: mockDomainConfig,
            environment: "all",
            type: "both",
        });

        // IPFS is canonical
        expect(result.tagObject.id).toBe("ipfs-canonical");
        expect(result.tagObject.ipfsId).toBe("ipfs-canonical");
        expect(result.tagObject.cid).toBe("QmCanonical");
        expect(result.tagObject.ipfsContentUrl).toBe("https://ipfs.zelf.world/ipfs/QmCanonical");
        // Arweave enriches supplementary info
        expect(result.tagObject.arweaveId).toBe("ar-tx-supplementary");
        expect(result.tagObject.arweaveUrl).toBe("https://arweave.net/txSupplementary");
        // IPFS publicData takes precedence over Arweave on collision, while retaining unique Arweave fields
        expect(result.tagObject.publicData.sharedField).toBe("fromIPFS");
        expect(result.tagObject.publicData.arweaveField).toBe("arValue");
    });

    it("does not break the call when Arweave times out or errors", async () => {
        const ipfsResult = [
            {
                id: "ipfs-456",
                name: "errortest.zelf",
                url: "https://ipfs.zelf.world/ipfs/QmTest2",
                publicData: { tagName: "errortest.zelf" },
            },
        ];

        jest.spyOn(TagsIPFSModule, "get").mockResolvedValue(ipfsResult);
        jest.spyOn(TagsArweaveModule, "searchByStorageKey").mockRejectedValue(new Error("Arweave network failure"));
        jest.spyOn(TagsPartsModule, "urlToBase64First").mockResolvedValue("data:image/png;base64,mockqr");

        const result = await TagsSearchModule.searchTag({
            tagName: "errortest.zelf",
            domain: "zelf",
            domainConfig: mockDomainConfig,
            environment: "all",
            type: "both",
        });

        expect(result.available).toBe(false);
        expect(result.searchIncomplete).toBeUndefined();
        expect(result.ipfs).toHaveLength(1);
        expect(result.arweave).toEqual([]);
        expect(result.tagObject.ipfsId).toBe("ipfs-456");
    });

    it("marks search complete (searchIncomplete=undefined) when IPFS has the tag copy even if Arweave times out", async () => {
        const ipfsResult = [
            {
                id: "ipfs-one-copy",
                name: "onecopy.zelf",
                url: "https://ipfs.zelf.world/ipfs/QmOneCopy",
                publicData: { tagName: "onecopy.zelf" },
            },
        ];

        jest.spyOn(TagsIPFSModule, "get").mockResolvedValue(ipfsResult);
        jest.spyOn(TagsArweaveModule, "searchByStorageKey").mockRejectedValue(new Error("SEARCH_TIMEOUT"));
        jest.spyOn(TagsPartsModule, "urlToBase64First").mockResolvedValue("data:image/png;base64,mockqr");

        const result = await TagsSearchModule.searchTag({
            tagName: "onecopy.zelf",
            domain: "zelf",
            domainConfig: mockDomainConfig,
            environment: "all",
            type: "both",
        });

        // As long as we have ONE copy from IPFS, search is complete and tag is taken
        expect(result.available).toBe(false);
        expect(result.searchIncomplete).toBeUndefined();
        expect(result.tagObject.ipfsId).toBe("ipfs-one-copy");
    });

    it("returns Arweave results if IPFS returns empty and Arweave has the tag", async () => {
        jest.spyOn(TagsIPFSModule, "get").mockResolvedValue([]);
        jest.spyOn(TagsArweaveModule, "searchByStorageKey").mockResolvedValue([
            {
                id: "ar-789",
                url: "https://arweave.net/tx789",
                publicData: { tagName: "arweavetag.zelf" },
            },
        ]);
        jest.spyOn(TagsPartsModule, "urlToBase64First").mockResolvedValue("data:image/png;base64,mockqr");

        const result = await TagsSearchModule.searchTag({
            tagName: "arweavetag.zelf",
            domain: "zelf",
            domainConfig: mockDomainConfig,
            environment: "all",
            type: "both",
        });

        expect(result.available).toBe(false);
        expect(result.arweave).toHaveLength(1);
        expect(result.tagObject.id).toBe("ar-789");
    });

    it("marks available=true when neither IPFS nor Arweave finds the tag and searches completed cleanly", async () => {
        jest.spyOn(TagsIPFSModule, "get").mockResolvedValue([]);
        jest.spyOn(TagsArweaveModule, "searchByStorageKey").mockResolvedValue([]);

        const result = await TagsSearchModule.searchTag({
            tagName: "availabletag.zelf",
            domain: "zelf",
            domainConfig: mockDomainConfig,
            environment: "all",
            type: "both",
        });

        expect(result.available).toBe(true);
        expect(result.searchIncomplete).toBeUndefined();
        expect(result.price).toBeDefined();
    });

    it("marks available=false and searchIncomplete=true when IPFS search fails or times out (issue #528)", async () => {
        // IPFS-only: no other store to satisfy OR semantics
        jest.spyOn(TagsIPFSModule, "get").mockRejectedValue(new Error("SEARCH_TIMEOUT"));

        const result = await TagsSearchModule.searchTag({
            tagName: "timeouttag.zelf",
            domain: "zelf",
            domainConfig: {
                ...mockDomainConfig,
                tags: { storage: { ipfsEnabled: true, arweaveEnabled: false, keyPrefix: "tagName" } },
            },
            environment: "ipfs",
            type: "both",
        });

        // Must NEVER report available=true if the only enabled store failed to respond
        expect(result.available).toBe(false);
        expect(result.searchIncomplete).toBe(true);
    });

    it("marks available=true when IPFS completes empty and Arweave times out (OR semantics)", async () => {
        jest.spyOn(TagsIPFSModule, "get").mockResolvedValue([]);
        jest.spyOn(TagsArweaveModule, "searchByStorageKey").mockRejectedValue(new Error("SEARCH_TIMEOUT"));

        const result = await TagsSearchModule.searchTag({
            tagName: "arweavetimeout.zelf",
            domain: "zelf",
            domainConfig: mockDomainConfig,
            environment: "all",
            type: "both",
        });

        // IPFS answered successfully; Arweave failure must not block availability
        expect(result.available).toBe(true);
        expect(result.searchIncomplete).toBeUndefined();
        expect(result.ipfs).toEqual([]);
        expect(result.arweave).toEqual([]);
    });

    it("marks available=true when Arweave completes empty and IPFS times out (OR semantics)", async () => {
        jest.spyOn(TagsIPFSModule, "get").mockRejectedValue(new Error("SEARCH_TIMEOUT"));
        jest.spyOn(TagsArweaveModule, "searchByStorageKey").mockResolvedValue([]);

        const result = await TagsSearchModule.searchTag({
            tagName: "ipfstimeout.zelf",
            domain: "zelf",
            domainConfig: mockDomainConfig,
            environment: "all",
            type: "both",
        });

        expect(result.available).toBe(true);
        expect(result.searchIncomplete).toBeUndefined();
        expect(result.ipfs).toEqual([]);
        expect(result.arweave).toEqual([]);
    });

    it("marks available=false and searchIncomplete=true when both IPFS and Arweave fail", async () => {
        jest.spyOn(TagsIPFSModule, "get").mockRejectedValue(new Error("SEARCH_TIMEOUT"));
        jest.spyOn(TagsArweaveModule, "searchByStorageKey").mockRejectedValue(new Error("SEARCH_TIMEOUT"));

        const result = await TagsSearchModule.searchTag({
            tagName: "bothfail.zelf",
            domain: "zelf",
            domainConfig: mockDomainConfig,
            environment: "all",
            type: "both",
        });

        expect(result.available).toBe(false);
        expect(result.searchIncomplete).toBe(true);
    });

    it("queries .hold and mainnet in parallel without switch fallthrough in searchIPFS", async () => {
        const getSpy = jest.spyOn(TagsIPFSModule, "get").mockResolvedValue([]);

        await TagsSearchModule.searchIPFS({
            tagName: "myname.zelf",
            domain: "zelf",
            domainConfig: mockDomainConfig,
            type: "hold",
        });

        // hold type should only call once for .hold
        expect(getSpy).toHaveBeenCalledTimes(1);
        expect(getSpy.mock.calls[0][0].tagName).toBe("myname.zelf.hold");

        getSpy.mockClear();

        await TagsSearchModule.searchIPFS({
            tagName: "myname.zelf",
            domain: "zelf",
            domainConfig: mockDomainConfig,
            type: "mainnet",
        });

        // mainnet type should only call once for mainnet
        expect(getSpy).toHaveBeenCalledTimes(1);
        expect(getSpy.mock.calls[0][0].tagName).toBe("myname.zelf");

        getSpy.mockClear();

        await TagsSearchModule.searchIPFS({
            tagName: "myname.zelf",
            domain: "zelf",
            domainConfig: mockDomainConfig,
            type: "both",
        });

        // both type calls twice in parallel (one for mainnet, one for hold)
        expect(getSpy).toHaveBeenCalledTimes(2);
        const calledNames = getSpy.mock.calls.map((c) => c[0].tagName);
        expect(calledNames).toContain("myname.zelf");
        expect(calledNames).toContain("myname.zelf.hold");
    });
});
