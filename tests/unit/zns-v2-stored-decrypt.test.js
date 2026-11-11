process.env.SOLANA_TOKEN_MINT_ADDRESS =
    process.env.SOLANA_TOKEN_MINT_ADDRESS || "11111111111111111111111111111111";

jest.mock("../../Repositories/Wallet/modules/encryption", () => ({
    decrypt: jest.fn(),
    encrypt: jest.fn(),
    preview: jest.fn(),
    encryptQR: jest.fn(),
}));

const { decrypt } = require("../../Repositories/Wallet/modules/encryption");
const ZNSSearchModule = require("../../Repositories/ZelfNameService/modules/zns-search.module");
const { decryptZelfName } = require("../../Repositories/ZelfNameService/modules/zns.v2.module");

describe("legacy ZNS decrypt uses the stored record", () => {
    beforeEach(() => {
        jest.spyOn(ZNSSearchModule, "searchZelfName").mockReset();
        decrypt.mockReset();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test("decrypts the stored zelfProof when the caller also sends a blob", async () => {
        ZNSSearchModule.searchZelfName.mockResolvedValue({
            ipfs: [
                {
                    publicData: { zelfProof: "stored-proof", zelfName: "alice.zelf" },
                    zelfProof: "stored-proof",
                },
            ],
            arweave: [],
        });
        decrypt.mockResolvedValue({ error: { code: "ERR_INVALID_PASSWORD" } });

        await expect(
            decryptZelfName(
                {
                    zelfName: "alice.zelf",
                    zelfProof: "caller-supplied-proof",
                    faceBase64: "face",
                    password: "secret",
                    removePGP: true,
                },
                {}
            )
        ).rejects.toMatchObject({ status: 409 });

        expect(decrypt).toHaveBeenCalledTimes(1);
        expect(decrypt.mock.calls[0][0].zelfProof).toBe("stored-proof");
    });

    test("does not fall back to the caller blob when the stored record has no zelfProof", async () => {
        ZNSSearchModule.searchZelfName.mockResolvedValue({
            ipfs: [{ publicData: { zelfName: "alice.zelf" } }],
            arweave: [{ publicData: { zelfName: "alice.zelf" } }],
        });

        await expect(
            decryptZelfName(
                {
                    zelfName: "alice.zelf",
                    zelfProof: "caller-supplied-proof",
                    faceBase64: "face",
                    password: "secret",
                    removePGP: true,
                },
                {}
            )
        ).rejects.toMatchObject({
            status: 404,
            code: "STORED_RECORD_NOT_FOUND",
        });

        expect(decrypt).not.toHaveBeenCalled();
    });
});
