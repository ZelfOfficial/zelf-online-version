jest.mock("../../Repositories/ZelfID/modules/zelf-id.module", () => ({
    searchTag: jest.fn(),
    _findDuplicatedTag: jest.fn(),
    _validateReferral: jest.fn(),
    _createWalletsFromPhrase: jest.fn(),
    persistZelfIdLease: jest.fn(),
}));

jest.mock("../../Repositories/ZelfID/modules/zelf-id-parts.module", () => ({
    decryptParams: jest.fn(),
    assignProperties: jest.fn(),
    generateZelfProof: jest.fn(),
    generatePGPKeys: jest.fn(),
}));

jest.mock("../../Repositories/ZelfProof/modules/zelf-proof.module", () => {
    const actual = jest.requireActual("../../Repositories/ZelfProof/modules/zelf-proof.module");
    return {
        ...actual,
        decrypt: jest.fn(),
    };
});

jest.mock("../../Repositories/Tags/config/supported-domains", () => ({
    getDomainConfig: jest.fn(() => ({
        getTagKey: () => "tagName",
    })),
}));

const ZelfIdModule = require("../../Repositories/ZelfID/modules/zelf-id.module");
const ZelfIdPartsModule = require("../../Repositories/ZelfID/modules/zelf-id-parts.module");
const ZelfProofModule = require("../../Repositories/ZelfProof/modules/zelf-proof.module");
const ZelfIdRecoveryModule = require("../../Repositories/ZelfID/modules/zelf-id-recovery.module");
const { errorHandler } = require("../../Core/http-handler");

describe("ZelfID leaseRecovery (Issue #182)", () => {
    const authUser = { session: "sess-1" };
    const sampleWallets = {
        eth: { address: "0x1111111111111111111111111111111111111111" },
        btc: { address: "bc1qtest" },
        solana: { address: "SolTest111", secretKey: "sol-secret" },
        sui: { address: "0xsui" },
        stellar: { address: "GABC123", secretKey: "SABC123" },
        polkadot: { address: "5GrwvaEF", secretKey: "dot-secret" },
        kusama: { address: "HNZata7i", secretKey: "ksm-secret" },
        ton: { address: "UQton" },
        aptos: { address: "0xaptos" },
        zkProof: "zk-proof",
        mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        arweave: { address: "ar-addr", privateKey: {} },
    };

    beforeEach(() => {
        jest.clearAllMocks();

        ZelfIdModule.searchTag.mockResolvedValue({ available: true });
        ZelfIdModule._findDuplicatedTag.mockResolvedValue(undefined);
        ZelfIdModule._validateReferral.mockResolvedValue(null);
        ZelfIdModule._createWalletsFromPhrase.mockResolvedValue(sampleWallets);
        ZelfIdModule.persistZelfIdLease.mockImplementation(async (tagObject) => {
            tagObject.ipfs = { id: "ipfs-new", publicData: { tagName: tagObject.tagName } };
            tagObject.arweave = { id: "ar-new" };
        });

        ZelfIdPartsModule.decryptParams.mockImplementation(async (payload) => ({
            face: payload.faceBase64,
            password: payload.password,
        }));
        ZelfIdPartsModule.assignProperties.mockImplementation((tagObject) => {
            tagObject.zelfProofQRCode = "data:image/png;base64,QR";
        });
        ZelfIdPartsModule.generateZelfProof.mockImplementation(async (_dataToEncrypt, tagObject) => {
            tagObject.zelfProof = "minted-new-zelfproof";
        });
        ZelfIdPartsModule.generatePGPKeys.mockResolvedValue({
            encryptedMessage: "pgp-msg",
            privateKey: "pgp-priv",
        });
    });

    it("recovers onto the same tagName (re-lease) and keeps the original zelfProof when skipZelfProof is true", async () => {
        ZelfProofModule.decrypt.mockResolvedValueOnce({
            metadata: { mnemonic: sampleWallets.mnemonic },
            publicData: { tagName: "alice.zelf", ethAddress: sampleWallets.eth.address },
        });

        const result = await ZelfIdRecoveryModule.leaseRecovery(
            {
                zelfProof: "original-proof",
                tagName: "alice.zelf",
                domain: "zelf",
                faceBase64: "face-b64",
                password: "secret",
                os: "DESKTOP",
            },
            authUser,
        );

        expect(result.available).toBe(false);
        expect(result.tagObject.zelfProof).toBe("original-proof");
        expect(ZelfIdModule.persistZelfIdLease).toHaveBeenCalledTimes(1);
    });

    it("recovers onto a new tagName when the source Zelf ID has expired", async () => {
        ZelfProofModule.decrypt.mockResolvedValueOnce({
            metadata: { mnemonic: sampleWallets.mnemonic },
            publicData: { tagName: "oldname.zelf", ethAddress: sampleWallets.eth.address },
        });

        ZelfIdModule.searchTag.mockImplementation(async (query) => {
            if (query.key === "zelfProof") return { available: true };
            if (query.tagName === "oldname.zelf") {
                return {
                    available: false,
                    tagObject: {
                        publicData: {
                            tagName: "oldname.zelf",
                            ethAddress: sampleWallets.eth.address,
                            expiresAt: "2020-01-01 00:00:00",
                        },
                    },
                };
            }
            return { available: true };
        });

        const result = await ZelfIdRecoveryModule.leaseRecovery(
            {
                zelfProof: "expired-proof",
                tagName: "newname.zelf",
                domain: "zelf",
                faceBase64: "face-b64",
                password: "NO_PASSWORD_PLACEHOLDER",
                os: "DESKTOP",
            },
            authUser,
        );

        expect(ZelfProofModule.decrypt).toHaveBeenCalledWith(
            expect.objectContaining({
                password: null,
                zelfProof: "expired-proof",
                stack: "v4",
            }),
        );
        expect(result.name).toBe("newname.zelf");
        expect(result.tagObject.zelfProof).toBe("minted-new-zelfproof");
    });

    it("rejects recovery onto a new tagName with 409 ERR_ZELF_ID_STILL_ACTIVE when the source Zelf ID is active", async () => {
        ZelfProofModule.decrypt.mockResolvedValueOnce({
            metadata: { mnemonic: sampleWallets.mnemonic },
            publicData: { tagName: "activename.zelf", ethAddress: sampleWallets.eth.address },
        });

        ZelfIdModule.searchTag.mockImplementation(async (query) => {
            if (query.key === "zelfProof") return { available: true };
            if (query.tagName === "activename.zelf") {
                return {
                    available: false,
                    tagObject: {
                        publicData: {
                            tagName: "activename.zelf",
                            ethAddress: sampleWallets.eth.address,
                            expiresAt: "2099-01-01 00:00:00",
                        },
                    },
                };
            }
            return { available: true };
        });

        await expect(
            ZelfIdRecoveryModule.leaseRecovery(
                {
                    zelfProof: "active-proof",
                    tagName: "secondname.zelf",
                    domain: "zelf",
                    faceBase64: "face-b64",
                    os: "DESKTOP",
                },
                authUser,
            ),
        ).rejects.toMatchObject({
            message: "409:zelf_id_still_active",
            clientCode: "ERR_ZELF_ID_STILL_ACTIVE",
        });
    });

    it("maps decrypt { error } payload to 401 ERR_INVALID_PASSWORD instead of crashing on undefined metadata", async () => {
        ZelfProofModule.decrypt.mockResolvedValueOnce({
            error: { code: "ERR_INVALID_PASSWORD", message: "Invalid password" },
        });

        let caught;
        try {
            await ZelfIdRecoveryModule.leaseRecovery(
                {
                    zelfProof: "proof",
                    tagName: "alice.zelf",
                    domain: "zelf",
                    faceBase64: "face-b64",
                    password: "wrong",
                    os: "DESKTOP",
                },
                authUser,
            );
        } catch (err) {
            caught = err;
        }

        expect(caught).toBeDefined();
        const handled = errorHandler(caught);
        expect(handled.status).toBe(401);
        expect(handled.code).toBe("ERR_INVALID_PASSWORD");
    });
});

