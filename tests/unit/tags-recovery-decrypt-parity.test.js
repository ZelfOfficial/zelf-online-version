/**
 * Decrypt-flow audit: tags/lease-recovery strips the face-only placeholder and uses the v4 stack;
 * tags/preview-zelfproof falls back across stacks; zelf-ids recovery keeps a client code on 409.
 */
jest.mock("../../Repositories/Wallet/modules/stellar", () => ({ createStellarWallet: jest.fn(), healPublicDataXlm: jest.fn() }));
jest.mock("../../Repositories/ZelfProof/modules/zelf-proof.module", () => {
    const actual = jest.requireActual("../../Repositories/ZelfProof/modules/zelf-proof.module");
    return { ...actual, decrypt: jest.fn(), preview: jest.fn(), previewWithLegacyFallback: jest.fn() };
});
jest.mock("../../Repositories/Tags/modules/tags-parts.module", () => ({ decryptParams: jest.fn() }));
jest.mock("../../Repositories/Tags/modules/tags.module", () => {
    const actual = jest.requireActual("../../Repositories/Tags/modules/tags.module");
    return { ...actual, searchTag: jest.fn(), _findDuplicatedTag: jest.fn() };
});

const ZelfProof = require("../../Repositories/ZelfProof/modules/zelf-proof.module");
const TagsParts = require("../../Repositories/Tags/modules/tags-parts.module");
const Tags = require("../../Repositories/Tags/modules/tags.module");
const { leaseRecovery } = require("../../Repositories/Tags/modules/tags-recovery.module");

const STOP = new Error("stop-after-decrypt");

describe("tags/lease-recovery decrypt parity", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        Tags.searchTag.mockResolvedValue({ available: true });
        Tags._findDuplicatedTag.mockResolvedValue();
        ZelfProof.decrypt.mockRejectedValue(STOP);
    });

    const run = async (password, securityType) => {
        TagsParts.decryptParams.mockResolvedValue({ face: "face", password });
        await expect(leaseRecovery({ zelfProof: "zp", tagName: "x", domain: "zelf", securityType }, {})).rejects.toBe(STOP);
        return ZelfProof.decrypt.mock.calls[0][0];
    };

    it("drops the NO_PASSWORD_PLACEHOLDER for face-only and uses stack v4", async () => {
        const args = await run("NO_PASSWORD_PLACEHOLDER", "withoutPassword");
        expect(args.password).toBeNull();
        expect(args.stack).toBe("v4");
    });

    it("ignores securityType (incl. legacy securePassword): a real password is always used", async () => {
        expect((await run("whatever", "withoutPassword")).password).toBe("whatever");
        expect((await run("whatever", "securePassword")).password).toBe("whatever");
    });

    it("keeps a real password", async () => {
        expect((await run("secret", "password")).password).toBe("secret");
    });
});

describe("tags/preview-zelfproof", () => {
    it("uses the v4→legacy fallback preview", async () => {
        ZelfProof.previewWithLegacyFallback.mockResolvedValue({ publicData: { zelfName: "abc.zelf" } });
        const out = await jest.requireActual("../../Repositories/Tags/modules/tags.module").previewZelfProof({ zelfProof: "zp" }, {});
        expect(ZelfProof.previewWithLegacyFallback).toHaveBeenCalledWith(expect.objectContaining({ zelfProof: "zp" }));
        expect(out).toMatchObject({ name: "abc", domain: "zelf" });
    });
});
