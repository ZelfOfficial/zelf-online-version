jest.mock("../../Repositories/Tags/modules/tags-parts.module", () => ({
    decryptParams: jest.fn(),
    decryptPasswordParams: jest.fn(),
    getFullTagName: jest.fn((tagName, domain) => {
        const resolvedDomain = domain || "zelf";
        if (tagName && tagName.includes(`.${resolvedDomain}`)) return tagName;
        return `${tagName}.${resolvedDomain}`;
    }),
}));

jest.mock("../../Repositories/Tags/modules/tags.module", () => ({
    decryptTag: jest.fn(),
}));

jest.mock("../../Repositories/ZelfProof/modules/zelf-proof.module", () => ({
    encrypt: jest.fn(),
    decrypt: jest.fn(),
}));

jest.mock("../../Repositories/Tags/modules/qr-zelfproof-extractor.module", () => ({
    generateQRFromZelfProof: jest.fn(),
}));

jest.mock("../../Repositories/ZelfKeys/modules/zelf-key-ipfs.module", () => ({
    saveZelfKey: jest.fn(),
}));

jest.mock("../../Core/ipfs", () => ({
    pinFile: jest.fn(),
    filter: jest.fn(),
    deleteFiles: jest.fn(),
}));

const TagsPartsModule = require("../../Repositories/Tags/modules/tags-parts.module");
const TagsModule = require("../../Repositories/Tags/modules/tags.module");
const ZelfProofModule = require("../../Repositories/ZelfProof/modules/zelf-proof.module");
const QRZelfProofExtractor = require("../../Repositories/Tags/modules/qr-zelfproof-extractor.module");
const ZelfKeyModule = require("../../Repositories/ZelfKeys/modules/zelf-key.module");

describe("ZelfKeys bulk password module", () => {
    const authToken = {
        tagName: "alice",
        identifier: "alice",
        domain: "zelf",
    };

    const baseRequest = {
        faceBase64: "encrypted-face",
        masterPassword: "encrypted-master",
        removePGP: true,
        passwords: [
            {
                website: "https://good.example",
                username: "good@example.com",
                password: "good-secret",
            },
            {
                website: "https://bad.example",
                username: "bad@example.com",
                password: "bad-secret",
            },
        ],
    };

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, "error").mockImplementation(() => {});

        TagsPartsModule.decryptParams.mockResolvedValue({
            face: "decrypted-face",
            password: "decrypted-master",
        });
        TagsModule.decryptTag.mockResolvedValue({});
        TagsPartsModule.decryptPasswordParams.mockImplementation(async (params) => ({
            password: params.password,
        }));
        ZelfProofModule.encrypt.mockResolvedValue({ zelfProof: "mock-zelf-proof" });
        QRZelfProofExtractor.generateQRFromZelfProof.mockResolvedValue("mock-qr-code");
    });

    afterEach(() => {
        console.error.mockRestore();
    });

    it("stores multiple passwords after a single ownership check", async () => {
        const result = await ZelfKeyModule.storePasswordsBulk(baseRequest, authToken);

        expect(TagsPartsModule.decryptParams).toHaveBeenCalledTimes(1);
        expect(TagsModule.decryptTag).toHaveBeenCalledTimes(1);
        expect(TagsPartsModule.decryptPasswordParams).toHaveBeenCalledTimes(2);
        expect(result.successCount).toBe(2);
        expect(result.failedCount).toBe(0);
        expect(result.success).toHaveLength(2);
        expect(result.success[0]).toMatchObject({
            index: 0,
            type: "password",
            zelfProof: "mock-zelf-proof",
        });
        expect(result.maxBatchSize).toBe(100);
    });

    it("fails the whole request when face or masterPassword verification fails", async () => {
        TagsModule.decryptTag.mockRejectedValue(new Error("412:encryption_key_didnt_match"));

        await expect(ZelfKeyModule.storePasswordsBulk(baseRequest, authToken)).rejects.toThrow(
            /412:encryption_key_didnt_match/
        );
        expect(TagsPartsModule.decryptPasswordParams).not.toHaveBeenCalled();
    });

    it("reports per-row decrypt failures while storing the rest", async () => {
        TagsPartsModule.decryptPasswordParams.mockImplementation(async (params) => {
            if (params.password === "bad-secret") {
                throw new Error("412:encryption_key_didnt_match");
            }

            return { password: params.password };
        });

        const result = await ZelfKeyModule.storePasswordsBulk(baseRequest, authToken);

        expect(result.successCount).toBe(1);
        expect(result.failedCount).toBe(1);
        expect(result.success[0].index).toBe(0);
        expect(result.failed[0]).toMatchObject({
            index: 1,
            message: "encryption_key_didnt_match",
            code: "PreconditionFailed",
        });
    });

    it("reports invalid credential rows without aborting the batch", async () => {
        const result = await ZelfKeyModule.storePasswordsBulk(
            {
                ...baseRequest,
                passwords: [
                    {
                        website: "https://good.example",
                        username: "good@example.com",
                        password: "good-secret",
                    },
                    {
                        username: "missing-website@example.com",
                        password: "secret",
                    },
                ],
            },
            authToken
        );

        expect(result.successCount).toBe(1);
        expect(result.failedCount).toBe(1);
        expect(result.failed[0]).toMatchObject({
            index: 1,
            code: "ValidationError",
        });
        expect(result.failed[0].message).toMatch(/website/i);
    });
});
