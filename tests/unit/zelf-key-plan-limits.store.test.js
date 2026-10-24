jest.mock("../../Repositories/Tags/modules/tags-parts.module", () => ({
    decryptParams: jest.fn(),
    decryptPasswordParams: jest.fn(),
    decryptCreditCardParams: jest.fn(),
    decryptNotesParams: jest.fn(),
    urlToBase64: jest.fn(),
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
    preview: jest.fn(),
    ZELFPROOF_CLIENT_ERROR_STATUS: {},
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
    getFileById: jest.fn(),
}));

const config = require("../../Core/config");
const TagsPartsModule = require("../../Repositories/Tags/modules/tags-parts.module");
const TagsModule = require("../../Repositories/Tags/modules/tags.module");
const ZelfProofModule = require("../../Repositories/ZelfProof/modules/zelf-proof.module");
const QRZelfProofExtractor = require("../../Repositories/Tags/modules/qr-zelfproof-extractor.module");
const IPFS = require("../../Core/ipfs");
const ZelfKeyModule = require("../../Repositories/ZelfKeys/modules/zelf-key.module");
const { errorHandler } = require("../../Core/http-handler");

const authToken = { tagName: "alice", identifier: "device-fingerprint-abc", domain: "zelf" };

const rows = (kind, count) =>
    Array.from({ length: count }, (_, index) => ({
        id: `${kind}-${index}`,
        cid: `cid-${kind}-${index}`,
        publicData: {
            category: `alice.zelf_${kind}`,
            keyOwner: "alice.zelf",
            type: kind,
            website: `https://site${index}.example`,
            username: `user${index}`,
            issuer: "GitHub",
        },
    }));

describe("Zelf Keys store enforces plan limits", () => {
    let originalPrice;

    beforeAll(() => {
        originalPrice = config.token.priceUsd;
        config.token.priceUsd = 0.05;
    });

    afterAll(() => {
        config.token.priceUsd = originalPrice;
    });

    beforeEach(() => {
        config.token.priceUsd = 0.05;
        jest.clearAllMocks();
        jest.spyOn(console, "error").mockImplementation(() => {});
        jest.spyOn(console, "warn").mockImplementation(() => {});

        TagsPartsModule.decryptParams.mockResolvedValue({ face: "decrypted-face", password: undefined });
        TagsModule.decryptTag.mockResolvedValue({ publicData: { plan: "free", type: "mainnet", zelfName: "alice.zelf" } });
        TagsPartsModule.decryptPasswordParams.mockResolvedValue({ password: "site-secret" });
        TagsPartsModule.decryptNotesParams.mockResolvedValue({ keyValuePairs: { note: "a" } });
        ZelfProofModule.encrypt.mockResolvedValue({ zelfProof: "mock-proof" });
        QRZelfProofExtractor.generateQRFromZelfProof.mockResolvedValue("mock-qr");
        IPFS.filter.mockImplementation(async (_key, value) => {
            const category = String(value);
            if (category.includes("_password")) return rows("password", 5);
            if (category.includes("_zotp")) return rows("zotp", 3);
            return [];
        });
    });

    afterEach(() => {
        console.error.mockRestore();
        console.warn.mockRestore();
    });

    const passwordBody = (extra = {}) => ({
        type: "password",
        website: "https://new.example",
        username: "new@example.com",
        password: "secret",
        faceBase64: "face",
        ...extra,
    });

    test("the 6th password on Free is rejected with the unlock cost", async () => {
        try {
            await ZelfKeyModule.storeData(passwordBody(), authToken);
            throw new Error("expected storeData to throw");
        } catch (error) {
            const handled = errorHandler(error);
            expect(handled.status).toBe(409);
            expect(handled.code).toBe("ERR_PLAN_LIMIT_REACHED");
            expect(error.details).toMatchObject({
                kind: "password",
                count: 5,
                limit: 5,
                plan: "free",
                tokenCost: 10,
            });
        }
        expect(ZelfProofModule.encrypt).not.toHaveBeenCalled();
    });

    test("the 4th 2FA account on Free is rejected", async () => {
        await expect(
            ZelfKeyModule.storeData(
                {
                    type: "zotp",
                    username: "new@example.com",
                    setupKey: "JBSWY3DPEHPK3PXP",
                    issuer: "GitHub",
                    faceBase64: "face",
                },
                authToken,
            ),
        ).rejects.toMatchObject({ clientCode: "ERR_PLAN_LIMIT_REACHED" });
        expect(ZelfProofModule.encrypt).not.toHaveBeenCalled();
    });

    test("editing an existing password is not blocked at the cap", async () => {
        await ZelfKeyModule.storeData(passwordBody({ id: "password-0", website: "https://site0.example", username: "user0" }), authToken);
        expect(ZelfProofModule.encrypt).toHaveBeenCalled();
    });

    test("notes are not capped by the password limit", async () => {
        await ZelfKeyModule.storeData(
            {
                type: "notes",
                title: "Note",
                keyValuePairs: { note: "a" },
                faceBase64: "face",
            },
            authToken,
        );
        expect(ZelfProofModule.encrypt).toHaveBeenCalled();
    });

    test("premium can store past the free password cap", async () => {
        TagsModule.decryptTag.mockResolvedValue({ publicData: { plan: "premium", type: "mainnet", zelfName: "alice.zelf" } });
        await ZelfKeyModule.storeData(passwordBody(), authToken);
        expect(ZelfProofModule.encrypt).toHaveBeenCalled();
    });

    test("a bulk import stops at the remaining free slots", async () => {
        IPFS.filter.mockImplementation(async (_key, value) => (String(value).includes("_password") ? rows("password", 4) : []));

        const result = await ZelfKeyModule.storePasswordsBulk(
            {
                faceBase64: "face",
                removePGP: true,
                passwords: [
                    { website: "https://one.example", username: "one", password: "a" },
                    { website: "https://two.example", username: "two", password: "b" },
                ],
            },
            authToken,
        );

        expect(result.successCount).toBe(1);
        expect(result.failedCount).toBe(1);
        expect(result.failed[0]).toMatchObject({
            code: "ERR_PLAN_LIMIT_REACHED",
            kind: "password",
            count: 5,
            limit: 5,
            plan: "free",
            tokenCost: 10,
        });
    });
});
