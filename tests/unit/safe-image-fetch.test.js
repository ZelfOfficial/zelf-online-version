const dns = require("dns").promises;
const { assertSafeImageUrl, fetchAllowedImage, isBlockedAddress } = require("../../Core/safe-image-fetch");
const { extractZelfProofFromQR } = require("../../Repositories/Tags/modules/qr-zelfproof-extractor.module");

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);

const publicLookup = async () => [{ address: "1.2.3.4", family: 4 }];

const listingTransport = (responses) => {
    const calls = [];
    const transport = async (checked) => {
        calls.push(checked.href);
        const next = responses.shift();
        if (!next) throw new Error("unexpected image fetch");
        return next;
    };
    transport.calls = calls;
    return transport;
};

describe("safe image fetch", () => {
    test("blocks private, loopback, link-local, and metadata addresses", () => {
        expect(isBlockedAddress("127.0.0.1")).toBe(true);
        expect(isBlockedAddress("10.1.2.3")).toBe(true);
        expect(isBlockedAddress("192.168.0.4")).toBe(true);
        expect(isBlockedAddress("169.254.169.254")).toBe(true);
        expect(isBlockedAddress("169.254.1.1")).toBe(true);
        expect(isBlockedAddress("::1")).toBe(true);
        expect(isBlockedAddress("fe80::1")).toBe(true);
        expect(isBlockedAddress("fc00::1")).toBe(true);
        expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
        expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
        expect(isBlockedAddress("2002:a9fe:a9fe::")).toBe(true);
        expect(isBlockedAddress("8.8.8.8")).toBe(false);
        expect(isBlockedAddress("2001:4860:4860::8888")).toBe(false);
    });

    test("does not fetch a metadata address or a private DNS answer", async () => {
        const transport = jest.fn();
        await expect(
            fetchAllowedImage("https://169.254.169.254/", { lookup: publicLookup, transport })
        ).rejects.toMatchObject({ code: "IMAGE_URL_BLOCKED_ADDRESS" });

        await expect(
            fetchAllowedImage("http://169.254.169.254/", { lookup: publicLookup, transport })
        ).rejects.toMatchObject({ code: "IMAGE_URL_NOT_HTTPS" });

        await expect(
            fetchAllowedImage("https://gateway.pinata.cloud/ipfs/bafy", {
                lookup: async () => [{ address: "127.0.0.1", family: 4 }],
                transport,
            })
        ).rejects.toMatchObject({ code: "IMAGE_URL_BLOCKED_ADDRESS" });

        expect(transport).not.toHaveBeenCalled();
    });

    test("checks a redirect again and does not request a blocked target", async () => {
        const transport = listingTransport([
            { status: 302, headers: { location: "https://169.254.169.254/" }, buffer: Buffer.alloc(0) },
        ]);

        await expect(
            fetchAllowedImage("https://arweave.net/example-tx", { lookup: publicLookup, transport })
        ).rejects.toMatchObject({ code: "IMAGE_URL_BLOCKED_ADDRESS" });

        expect(transport.calls).toEqual(["https://arweave.net/example-tx"]);
    });

    test("checks a redirect onto an allowlisted host that resolves to a private address", async () => {
        const transport = listingTransport([
            { status: 302, headers: { location: "https://ipfs.io/ipfs/bafyredirect" }, buffer: Buffer.alloc(0) },
        ]);
        const lookup = async (hostname) => {
            if (hostname === "ipfs.io") return [{ address: "10.0.0.8", family: 4 }];
            return [{ address: "1.1.1.1", family: 4 }];
        };

        await expect(fetchAllowedImage("https://gateway.pinata.cloud/ipfs/bafy", { lookup, transport })).rejects.toMatchObject({
            code: "IMAGE_URL_BLOCKED_ADDRESS",
        });
        expect(transport.calls).toEqual(["https://gateway.pinata.cloud/ipfs/bafy"]);
    });

    test("downloads a PNG from an allowlisted gateway", async () => {
        const transport = listingTransport([
            { status: 200, headers: { "content-type": "image/png" }, buffer: PNG },
        ]);
        const image = await fetchAllowedImage("https://gateway.pinata.cloud/ipfs/bafyproof", {
            lookup: publicLookup,
            transport,
        });

        expect(image.contentType).toBe("image/png");
        expect(image.buffer.equals(PNG)).toBe(true);
        expect(transport.calls).toEqual(["https://gateway.pinata.cloud/ipfs/bafyproof"]);
    });

    test("rejects a non-image response", async () => {
        const transport = listingTransport([
            { status: 200, headers: { "content-type": "text/html" }, buffer: Buffer.from("<html></html>") },
        ]);
        await expect(
            fetchAllowedImage("https://ipfs.zelf.world/ipfs/bafy", { lookup: publicLookup, transport })
        ).rejects.toMatchObject({ code: "IMAGE_URL_TYPE_NOT_ALLOWED" });
    });

    test("proof extraction does not fetch a metadata URL or a non-URL proof string", async () => {
        const lookup = jest.spyOn(dns, "lookup");
        await expect(extractZelfProofFromQR("https://169.254.169.254/")).resolves.toBeNull();
        const callsAfterMetadata = lookup.mock.calls.length;

        await expect(extractZelfProofFromQR("aaahttpsbbb")).resolves.toBeNull();
        expect(lookup.mock.calls.length).toBe(callsAfterMetadata);
        lookup.mockRestore();
    });

    test("assertSafeImageUrl accepts an allowlisted host with a public address", async () => {
        const checked = await assertSafeImageUrl("https://alice_zelf.ar.io/txid", publicLookup);
        expect(checked.hostname).toBe("alice_zelf.ar.io");
        expect(checked.address).toBe("1.2.3.4");
    });
});
