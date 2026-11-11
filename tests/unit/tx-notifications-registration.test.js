/**
 * Device registration for received-transfer push (Zelf #566): canonical signed
 * message, EIP-191 signature check, freshness window, request shape and
 * per-network address validation. Pure logic, no network or database.
 */
const { Wallet, getAddress } = require("ethers");
const { Address } = require("@ton/core");

const {
    buildRegistrationMessage,
    isFresh,
    parseIssuedAt,
    verifyRegistrationSignature,
} = require("../../Repositories/TxNotifications/modules/registration-signature.util");
const { parseRegistrationBody, resolveAddresses } = require("../../Repositories/TxNotifications/modules/registration-input.util");
const { validateNetworkAddress } = require("../../Repositories/TxNotifications/modules/address-validation.util");

const NOW = Date.parse("2026-09-30T15:04:05.000Z");

const signedBody = async (wallet, overrides = {}) => {
    const body = {
        pushSubscriptionId: "0b2b3c4d-1111-4222-8333-944455556666",
        platform: "android",
        language: "es",
        appVersion: "3.19.23",
        tagName: "qa99.zelf",
        addresses: {
            solana: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9",
            ethereum: wallet.address,
            ton: "EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N",
        },
        issuedAt: "2026-09-30T15:04:05.000Z",
        ...overrides,
    };
    body.signature = await wallet.signMessage(buildRegistrationMessage(body));
    return body;
};

describe("tx-notifications registration message", () => {
    it("is the exact contract text: header, push, platform, issuedAt, then addresses sorted by network", () => {
        const message = buildRegistrationMessage({
            pushSubscriptionId: "sub-123456",
            platform: "ios",
            issuedAt: "2026-09-30T15:04:05.000Z",
            addresses: { ton: "EQabc", ethereum: "0xB8aB", bitcoin: "bc1qxyz", solana: "E5zQ" },
        });

        expect(message).toBe(
            [
                "Zelf tx notifications v1",
                "push=sub-123456",
                "platform=ios",
                "issuedAt=2026-09-30T15:04:05.000Z",
                "bitcoin=bc1qxyz",
                "ethereum=0xB8aB",
                "solana=E5zQ",
                "ton=EQabc",
            ].join("\n")
        );
        expect(message.endsWith("\n")).toBe(false);
    });

    it("uses addresses exactly as sent (no case normalization)", () => {
        const base = { pushSubscriptionId: "sub-123456", platform: "android", issuedAt: "2026-09-30T15:04:05.000Z" };
        const checksummed = buildRegistrationMessage({ ...base, addresses: { ethereum: "0xAbC" } });
        const lower = buildRegistrationMessage({ ...base, addresses: { ethereum: "0xabc" } });
        expect(checksummed).not.toBe(lower);
    });
});

describe("tx-notifications signature verification", () => {
    const wallet = Wallet.createRandom();

    it("accepts a personal_sign signature by addresses.ethereum", async () => {
        expect(verifyRegistrationSignature(await signedBody(wallet))).toBe(true);
    });

    it("compares the recovered address case-insensitively", async () => {
        const body = await signedBody(wallet, { addresses: { ethereum: wallet.address.toLowerCase() } });
        expect(verifyRegistrationSignature(body)).toBe(true);
    });

    it("rejects a signature by another key", async () => {
        const other = Wallet.createRandom();
        const body = await signedBody(other);
        body.addresses.ethereum = wallet.address;
        expect(verifyRegistrationSignature(body)).toBe(false);
    });

    it("rejects any change to a signed field", async () => {
        const body = await signedBody(wallet);
        expect(verifyRegistrationSignature({ ...body, platform: "ios" })).toBe(false);
        expect(verifyRegistrationSignature({ ...body, pushSubscriptionId: "0b2b3c4d-1111-4222-8333-944455556667" })).toBe(false);
        expect(verifyRegistrationSignature({ ...body, issuedAt: "2026-09-30T15:04:06.000Z" })).toBe(false);
        expect(verifyRegistrationSignature({ ...body, addresses: { ...body.addresses, solana: "E5zQ3LHSjXGbHqDzcmyMhL1b3mfQ2ZTYSKCrFEDFBfXA" } })).toBe(false);
        const { ton, ...withoutTon } = body.addresses;
        expect(verifyRegistrationSignature({ ...body, addresses: withoutTon })).toBe(false);
    });

    it("never throws on garbage signatures", () => {
        expect(verifyRegistrationSignature({ addresses: { ethereum: wallet.address }, signature: "0x1234" })).toBe(false);
        expect(verifyRegistrationSignature({})).toBe(false);
    });
});

describe("tx-notifications issuedAt freshness", () => {
    it("accepts ±10 minutes around server time", () => {
        expect(isFresh("2026-09-30T15:04:05.000Z", NOW)).toBe(true);
        expect(isFresh("2026-09-30T14:54:05.000Z", NOW)).toBe(true);
        expect(isFresh("2026-09-30T15:14:05.000Z", NOW)).toBe(true);
    });

    it("rejects anything older or newer than 10 minutes", () => {
        expect(isFresh("2026-09-30T14:54:04.999Z", NOW)).toBe(false);
        expect(isFresh("2026-09-30T15:14:05.001Z", NOW)).toBe(false);
    });

    it("only accepts ISO-8601 UTC (Z) timestamps", () => {
        expect(parseIssuedAt("2026-09-30T15:04:05Z")).toBe(NOW);
        expect(parseIssuedAt("2026-09-30T15:04:05.000+00:00")).toBeNull();
        expect(parseIssuedAt("2026-09-30 15:04:05")).toBeNull();
        expect(parseIssuedAt(String(NOW))).toBeNull();
        expect(parseIssuedAt(NOW)).toBeNull();
    });
});

describe("tx-notifications request shape", () => {
    const wallet = Wallet.createRandom();

    it("normalizes a valid body (language lowercased, optional fields default)", async () => {
        const body = await signedBody(wallet, { language: "ES-co", appVersion: undefined, tagName: undefined });
        const parsed = parseRegistrationBody(body);
        expect(parsed.language).toBe("es-co");
        expect(parsed.appVersion).toBeNull();
        expect(parsed.tagName).toBeNull();
    });

    it.each([
        ["missing pushSubscriptionId", { pushSubscriptionId: undefined }],
        ["pushSubscriptionId with a newline", { pushSubscriptionId: "abc\ndef-12345" }],
        ["unknown platform", { platform: "web" }],
        ["non-UTC issuedAt", { issuedAt: "2026-09-30T15:04:05+02:00" }],
        ["short signature", { signature: "0x1234" }],
        ["addresses as array", { addresses: ["0xabc"] }],
        ["no ethereum address", { addresses: { solana: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9" } }],
        ["address with a newline (would forge extra signed lines)", { addresses: { ethereum: "0x28C6c06298d514Db089934071355E5743bf21d60", ton: "EQ\nsolana=x" } }],
        ["malformed network key", { addresses: { ethereum: "0x28C6c06298d514Db089934071355E5743bf21d60", "Sol ana": "x" } }],
    ])("rejects %s with 400 invalid_request", (_label, overrides) => {
        const body = {
            pushSubscriptionId: "0b2b3c4d-1111-4222-8333-944455556666",
            platform: "android",
            addresses: { ethereum: "0x28C6c06298d514Db089934071355E5743bf21d60" },
            issuedAt: "2026-09-30T15:04:05.000Z",
            signature: `0x${"ab".repeat(65)}`,
            ...overrides,
        };
        expect(() => parseRegistrationBody(body)).toThrow(expect.objectContaining({ status: 400, code: "invalid_request" }));
    });

    it("validates known networks, ignores unknown keys and marks polkadot/kusama as not watched", () => {
        const resolved = resolveAddresses({
            ethereum: "0x28C6c06298d514Db089934071355E5743bf21d60",
            polkadot: "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5",
            tron: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
        });
        expect(resolved.map((entry) => [entry.network, entry.watched])).toEqual([
            ["ethereum", true],
            ["polkadot", false],
        ]);
        expect(resolved[0].key).toBe("ethereum:0x28c6c06298d514db089934071355e5743bf21d60");
    });

    it("names the network, never the address, when one is invalid", () => {
        const attempt = () => resolveAddresses({ ethereum: "0x28C6c06298d514Db089934071355E5743bf21d60", solana: "not-a-solana-address" });
        expect(attempt).toThrow(expect.objectContaining({ status: 400, code: "invalid_request", message: "addresses.solana is not a valid solana address" }));
    });
});

describe("tx-notifications address validation", () => {
    const valid = (network, address) => validateNetworkAddress(network, address);

    it("EVM: checksummed and lowercase are the same account; a broken checksum is rejected", () => {
        const wallet = Wallet.createRandom();
        const checksummed = getAddress(wallet.address);
        expect(valid("ethereum", checksummed).key).toBe(checksummed.toLowerCase());
        expect(valid("bsc", checksummed.toLowerCase()).key).toBe(checksummed.toLowerCase());
        for (const network of ["polygon", "avalanche", "bsc"]) expect(valid(network, checksummed)).not.toBeNull();

        const letters = [...checksummed.slice(2)].map((c, i) => [c, i]).filter(([c]) => /[a-fA-F]/.test(c));
        const [letter, index] = letters[0];
        const flipped = `0x${checksummed.slice(2, index + 2)}${letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()}${checksummed.slice(index + 3)}`;
        expect(valid("ethereum", flipped)).toBeNull();
        expect(valid("ethereum", "0x1234")).toBeNull();
    });

    it("Solana: base58 of a 32-byte key", () => {
        expect(valid("solana", "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9").key).toBe("5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9");
        expect(valid("solana", "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvu")).toBeNull(); // 30 bytes
        expect(valid("solana", "0x28C6c06298d514Db089934071355E5743bf21d60")).toBeNull();
        expect(valid("solana", "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi0")).toBeNull();
    });

    it("Bitcoin: mainnet P2PKH, P2SH, P2WPKH and P2TR; checksum and network enforced", () => {
        expect(valid("bitcoin", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).not.toBeNull();
        expect(valid("bitcoin", "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy")).not.toBeNull();
        expect(valid("bitcoin", "bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h").key).toBe("bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h");
        expect(valid("bitcoin", "BC1QM34LSC65ZPW79LXES69ZKQMK6EE3EWF0J77S3H").key).toBe("bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h");
        expect(valid("bitcoin", "bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297")).not.toBeNull();
        expect(valid("bitcoin", "bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3j")).toBeNull();
        expect(valid("bitcoin", "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx")).toBeNull();
        expect(valid("bitcoin", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb")).toBeNull();
    });

    it("TON: EQ, UQ and raw spellings share one key; testnet addresses are rejected", () => {
        const eq = "EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N";
        const parsed = Address.parse(eq);
        const uq = parsed.toString({ bounceable: false, urlSafe: true });
        const raw = parsed.toRawString();
        const key = "0:83dfd552e63729b472fcbcc8c45ebcc6691702558b68ec7527e1ba403a0f31a8";

        expect(valid("ton", eq).key).toBe(key);
        expect(valid("ton", uq).key).toBe(key);
        expect(valid("ton", raw).key).toBe(key);
        expect(valid("ton", parsed.toString({ testOnly: true }))).toBeNull();
        expect(valid("ton", "EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2M")).toBeNull();
    });

    it("Aptos: 0x + up to 64 hex, padded to the long form; special short addresses rejected", () => {
        const long = "0x3d3a2dec4612a2da679901a70a41002b69e54619b2f43478c6225aadfdfcedbf";
        expect(valid("aptos", long).key).toBe(long);
        expect(valid("aptos", "0x0a3d3a2dec4612a2da679901a70a41002b69e54619b2f43478c6225aadfdfced".replace("0x0", "0x")).key).toBe(
            "0x0a3d3a2dec4612a2da679901a70a41002b69e54619b2f43478c6225aadfdfced"
        );
        expect(valid("aptos", "0x1")).toBeNull();
        expect(valid("aptos", `${long}00`)).toBeNull();
    });

    it("Sui: 0x + 64 hex", () => {
        expect(valid("sui", "0x7ba661f0e68dcfa31c8c20f21d42bc0b973920ee79904bd5683c9259a9925fdf")).not.toBeNull();
        expect(valid("sui", "0x7ba661f0e68dcfa31c8c20f21d42bc0b97392")).toBeNull();
    });

    it("Stellar: G… StrKey with a valid CRC16", () => {
        expect(valid("stellar", "GA5XIGA5C7QTPTWXQHY6MCJRMTRZDOSHR6EFIBNDQTCQHG262N4GGKTM")).not.toBeNull();
        expect(valid("stellar", "GA5XIGA5C7QTPTWXQHY6MCJRMTRZDOSHR6EFIBNDQTCQHG262N4GGKTN")).toBeNull();
        expect(valid("stellar", "ga5xiga5c7qtptwxqhy6mcjrmtrzdoshr6efibndqtcqhg262n4ggktm")).toBeNull();
        expect(valid("stellar", "SA5XIGA5C7QTPTWXQHY6MCJRMTRZDOSHR6EFIBNDQTCQHG262N4GGKTM")).toBeNull();
    });

    it("Polkadot/Kusama: SS58", () => {
        expect(valid("polkadot", "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5")).not.toBeNull();
        expect(valid("kusama", "not-ss58-at-all-not-ss58-at-all-not-ss58-at-all")).toBeNull();
    });

    it("rejects surrounding whitespace instead of silently trimming a signed value", () => {
        expect(valid("solana", " 5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9")).toBeNull();
    });
});
