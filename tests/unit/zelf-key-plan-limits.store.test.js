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

jest.mock("../../Repositories/Tags/config/supported-domains", () => ({
    isWalrusStorageSupported: () => false,
    isIPFSStorageSupported: () => true,
    isArweaveStorageSupported: () => false,
    getDomainConfig: () => null,
}));

jest.mock("../../Repositories/Face/middlewares/face.middleware", () => ({
    gate: jest.fn((action) => `gate:${action}`),
}));

const config = require("../../Core/config");
const TagsPartsModule = require("../../Repositories/Tags/modules/tags-parts.module");
const TagsModule = require("../../Repositories/Tags/modules/tags.module");
const ZelfProofModule = require("../../Repositories/ZelfProof/modules/zelf-proof.module");
const QRZelfProofExtractor = require("../../Repositories/Tags/modules/qr-zelfproof-extractor.module");
const IPFS = require("../../Core/ipfs");
const FaceMiddleware = require("../../Repositories/Face/middlewares/face.middleware");
const ZelfKeyModule = require("../../Repositories/ZelfKeys/modules/zelf-key.module");
const registerZelfKeyRoutes = require("../../Repositories/ZelfKeys/routes/zelf-key.route");
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
        require("../../Repositories/ZelfKeys/modules/zelf-key-ipfs.module").saveZelfKey.mockResolvedValue({ id: "new-pin" });
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

    test("editing an existing password replaces that record and does not raise the count", async () => {
        let passwords = rows("password", 5);
        IPFS.filter.mockImplementation(async (_key, value) => (String(value).includes("_password") ? passwords : []));
        require("../../Repositories/ZelfKeys/modules/zelf-key-ipfs.module").saveZelfKey.mockImplementation(async (payload) => {
            const id = `new-${passwords.length}`;
            passwords.push({ id, cid: id, publicData: payload.publicData });
            return { id };
        });
        IPFS.deleteFiles.mockImplementation(async (ids) => {
            const drop = new Set(ids);
            passwords = passwords.filter((row) => !drop.has(row.id) && !drop.has(row.cid));
        });

        await ZelfKeyModule.storeData(passwordBody({ id: "password-0", website: "https://site0.example", username: "user0" }), authToken);
        expect(passwords).toHaveLength(5);
        expect(passwords.some((row) => row.id === "password-0")).toBe(false);
        expect(IPFS.deleteFiles).toHaveBeenCalledWith(["password-0"]);

        await expect(ZelfKeyModule.storeData(passwordBody({ id: "password-0" }), authToken)).rejects.toMatchObject({
            clientCode: "ERR_PLAN_LIMIT_REACHED",
        });
        expect(passwords).toHaveLength(5);
    });

    test("cid wins over recordId, and a non-matching id is not an edit", async () => {
        await ZelfKeyModule.storeData(passwordBody({ cid: "cid-password-0", recordId: "password-1" }), authToken);
        expect(IPFS.deleteFiles).toHaveBeenCalledWith(["password-0"]);

        ZelfProofModule.encrypt.mockClear();
        IPFS.deleteFiles.mockClear();
        await expect(ZelfKeyModule.storeData(passwordBody({ id: "missing", cid: "cid-password-0" }), authToken)).rejects.toMatchObject({
            clientCode: "ERR_PLAN_LIMIT_REACHED",
        });
        expect(ZelfProofModule.encrypt).not.toHaveBeenCalled();
        expect(IPFS.deleteFiles).not.toHaveBeenCalled();
    });

    test("editing an existing 2FA account replaces it instead of adding a fourth record", async () => {
        let accounts = rows("zotp", 3);
        IPFS.filter.mockImplementation(async (_key, value) => (String(value).includes("_zotp") ? accounts : []));
        require("../../Repositories/ZelfKeys/modules/zelf-key-ipfs.module").saveZelfKey.mockImplementation(async (payload) => {
            const id = `new-zotp-${accounts.length}`;
            accounts.push({ id, cid: id, publicData: payload.publicData });
            return { id };
        });
        IPFS.deleteFiles.mockImplementation(async (ids) => {
            const drop = new Set(ids);
            accounts = accounts.filter((row) => !drop.has(row.id));
        });

        await ZelfKeyModule.storeData(
            {
                type: "zotp",
                username: "user0",
                setupKey: "JBSWY3DPEHPK3PXP",
                issuer: "GitHub",
                faceBase64: "face",
                id: "zotp-0",
            },
            authToken,
        );

        expect(accounts).toHaveLength(3);
        expect(accounts.some((row) => row.id === "zotp-0")).toBe(false);
        expect(IPFS.deleteFiles).toHaveBeenCalledWith(["zotp-0"]);
    });

    test("an identifier-only session can still save, and the cap applies to that owner", async () => {
        const deviceAuth = { identifier: "device-fingerprint-abc", domain: "zelf" };
        IPFS.filter.mockResolvedValue([]);

        await ZelfKeyModule.storeData(passwordBody(), deviceAuth);
        expect(ZelfProofModule.encrypt).toHaveBeenCalled();

        ZelfProofModule.encrypt.mockClear();
        IPFS.filter.mockImplementation(async (_key, value) => {
            if (!String(value).includes("_password")) return [];
            return rows("password", 5).map((row) => ({
                ...row,
                publicData: {
                    ...row.publicData,
                    keyOwner: "device-fingerprint-abc.zelf",
                    category: "device-fingerprint-abc.zelf_password",
                },
            }));
        });

        await expect(ZelfKeyModule.storeData(passwordBody(), deviceAuth)).rejects.toMatchObject({
            clientCode: "ERR_PLAN_LIMIT_REACHED",
        });
    });

    test("slot purchase checks the face the same way a key save does", async () => {
        const order = [];
        TagsModule.decryptTag.mockImplementation(async () => {
            order.push("face");
            return { publicData: { plan: "free", type: "mainnet", zelfName: "alice.zelf" } };
        });

        await expect(
            ZelfKeyModule.purchaseExtraSlot(
                { kind: "password", idempotencyKey: "idem-face-01", faceBase64: "face", masterPassword: "vault" },
                authToken,
            ),
        ).rejects.toBeTruthy();

        expect(order).toEqual(["face"]);
        expect(TagsModule.decryptTag).toHaveBeenCalledWith(
            expect.objectContaining({ faceBase64: "face", tagName: "alice" }),
            authToken,
        );
    });

    test("the slots route uses the face gate", () => {
        const posts = [];
        registerZelfKeyRoutes({
            post: (path, ...handlers) => posts.push({ path, handlers }),
            get: () => {},
            put: () => {},
        });
        const slots = posts.find((row) => row.path.endsWith("/zelf-keys/slots"));
        expect(FaceMiddleware.gate).toHaveBeenCalledWith("purchase-slot");
        expect(slots.handlers).toContain("gate:purchase-slot");
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
