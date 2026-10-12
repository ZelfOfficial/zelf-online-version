const { NO_PASSWORD_PLACEHOLDER, isNoPassword, effectivePassword, resolveSecurityType } = require("../../Repositories/ZelfID/modules/zelf-id-password.module");
const { _formattingError } = require("../../Repositories/ZelfProof/modules/zelf-proof.module");

jest.mock("../../Repositories/ZelfID/modules/zelf-id.module", () => ({ searchTag: jest.fn() }));
const ZelfIdModule = require("../../Repositories/ZelfID/modules/zelf-id.module");
const { _assertSourceNameNotActive } = require("../../Repositories/ZelfID/modules/zelf-id-recovery.module");

describe("zelf-id password normalization (backward compatible placeholder)", () => {
    it("treats empty and the placeholder as no password", () => {
        expect(isNoPassword("")).toBe(true);
        expect(isNoPassword(undefined)).toBe(true);
        expect(isNoPassword(NO_PASSWORD_PLACEHOLDER)).toBe(true);
        expect(isNoPassword("secret")).toBe(false);
    });

    it("drops the password for face-only proofs, placeholder, or withoutPassword", () => {
        expect(effectivePassword({ password: NO_PASSWORD_PLACEHOLDER })).toBeNull();
        expect(effectivePassword({ password: "x", securityType: "withoutPassword" })).toBeNull();
        expect(effectivePassword({ password: "x", hasPassword: "false" })).toBeNull();
        expect(effectivePassword({ password: "x", hasPassword: false })).toBeNull();
        expect(effectivePassword({ password: "x", hasPassword: "true" })).toBe("x");
        expect(effectivePassword({ password: "123456", securityType: "pin" })).toBe("123456");
    });

    it("honours explicit securityType and infers otherwise", () => {
        expect(resolveSecurityType("ab12cd", "pin")).toBe("pin");
        expect(resolveSecurityType("123456")).toBe("pin");
        expect(resolveSecurityType("longer-pass")).toBe("password");
        expect(resolveSecurityType(NO_PASSWORD_PLACEHOLDER, "pin")).toBe("withoutPassword");
        expect(resolveSecurityType(null)).toBe("withoutPassword");
        expect(resolveSecurityType("x", "bogus")).toBe("password");
    });
});

describe("ZelfProof error status mapping", () => {
    it.each([
        ["ERR_INVALID_PASSWORD", 401],
        ["ERR_PASSWORD_REQUIRED", 409],
        ["ERR_VERIFICATION_FAILED", 409],
        ["ERR_INVALID_ZELFPROOF_BYTES", 400],
    ])("%s -> %i even if upstream says 500", (code, status) => {
        expect(_formattingError({ code, message: "x", status: 500 }).status).toBe(status);
        expect(_formattingError({ code, message: "x" }).status).toBe(status);
    });

    it("leaves unknown errors at 500", () => {
        expect(_formattingError({ code: "ERR_SOMETHING", message: "boom" }).status).toBe(500);
    });
});

describe("recovery refuses an active source name for the same wallet", () => {
    const domainConfig = {};
    beforeEach(() => ZelfIdModule.searchTag.mockReset());

    it("throws 409 when the source name is active and owned by the same wallet", async () => {
        ZelfIdModule.searchTag.mockResolvedValue({ available: false, tagObject: { publicData: { ethAddress: "0xABC" } } });
        await expect(_assertSourceNameNotActive("alice", "zelf", domainConfig, "0xabc", "alice2")).rejects.toThrow("409:zelf_id_still_active");
    });

    it("allows recovery when the source name is free, expired, or owned by someone else", async () => {
        ZelfIdModule.searchTag.mockResolvedValueOnce({ available: true });
        await expect(_assertSourceNameNotActive("alice", "zelf", domainConfig, "0xabc", "alice2")).resolves.toBeUndefined();
        ZelfIdModule.searchTag.mockResolvedValueOnce({ available: false, tagObject: { publicData: { ethAddress: "0xabc", expiresAt: "2000-01-01" } } });
        await expect(_assertSourceNameNotActive("alice", "zelf", domainConfig, "0xabc", "alice2")).resolves.toBeUndefined();
        ZelfIdModule.searchTag.mockResolvedValueOnce({ available: false, tagObject: { publicData: { ethAddress: "0xdef" } } });
        await expect(_assertSourceNameNotActive("alice", "zelf", domainConfig, "0xabc", "alice2")).resolves.toBeUndefined();
    });

    it("skips the check when re-leasing onto the same name", async () => {
        await _assertSourceNameNotActive("alice", "zelf", domainConfig, "0xabc", "alice");
        expect(ZelfIdModule.searchTag).not.toHaveBeenCalled();
    });
});
