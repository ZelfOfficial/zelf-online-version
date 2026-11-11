const {
    RELEASE_SOURCE_VERIFIED_WEBHOOK,
    assertVerifiedReleaseSource,
    buildAtomicReleaseUpdate,
    isLicenseExtensionRecorded,
    isTokenPayoutRecorded,
    lockUnavailableError,
    tokensAlreadyReleasedError,
} = require("../../Repositories/PreSale/modules/presale-release.util");
const { filterOwnedRecords } = require("../../Repositories/IPFS/modules/ipfs-access.util");
const {
    assertRewardOwnedByVerifiedSession,
    firstTransactionClaimDecision,
} = require("../../Repositories/Rewards/modules/first-transaction-auth.util");
const { assertPasskeyOwner, assertStaffRoleChangeAllowed } = require("../../Repositories/Staff/modules/staff-auth.util");
const { resolveProvenVaultOwner } = require("../../Repositories/VaultLegacy/modules/vault-owner.util");
const { requirePreferencesOwner } = require("../../Repositories/Lawyer/modules/lawyer-owner.util");

describe("presale release hardening", () => {
    it("treats a payout as recorded only when the flag and the transaction are both present", () => {
        expect(isTokenPayoutRecorded({ tokensReleased: true, payoutTx: "sig123" })).toBe(true);
        expect(isTokenPayoutRecorded({ tokensReleased: true, payoutTx: "" })).toBe(false);
        expect(isTokenPayoutRecorded({ tokensReleased: false, payoutTx: "sig123" })).toBe(false);
    });

    it("treats a license extension as recorded only when the flag and the result are both present", () => {
        expect(isLicenseExtensionRecorded({ licenseExtended: true, licenseRecord: "2028-01-01T00:00:00.000Z" })).toBe(true);
        expect(isLicenseExtensionRecorded({ licenseExtended: true, licenseRecord: "" })).toBe(false);
    });

    it("writes each flag together with its recorded result", () => {
        expect(buildAtomicReleaseUpdate({ payoutTx: "sig123", licenseRecord: "alice.zelf" })).toEqual({
            tokensReleased: true,
            payoutTx: "sig123",
            licenseExtended: true,
            licenseRecord: "alice.zelf",
        });
        expect(buildAtomicReleaseUpdate({ payoutTx: "  ", licenseRecord: "" })).toEqual({});
    });

    it("allows release only from the verified webhook source", () => {
        expect(() => assertVerifiedReleaseSource(RELEASE_SOURCE_VERIFIED_WEBHOOK)).not.toThrow();
        expect(() => assertVerifiedReleaseSource("session-details")).toThrow("PRESALE_RELEASE_NOT_ALLOWED");
    });

    it("uses the upper snake error codes for lock and replay", () => {
        expect(lockUnavailableError()).toMatchObject({ code: "PAYMENT_LOCK_UNAVAILABLE", status: 409 });
        expect(tokensAlreadyReleasedError()).toMatchObject({ code: "TOKENS_ALREADY_RELEASED", status: 409 });
    });
});

describe("first transaction reward ownership", () => {
    it("rewards the stored verified name and rejects a different client name", () => {
        expect(assertRewardOwnedByVerifiedSession("alice.zelf", "alice", "zelf")).toBe("alice.zelf");
        expect(() => assertRewardOwnedByVerifiedSession("alice.zelf", "bob.zelf", "zelf")).toThrow(
            expect.objectContaining({ code: "TAG_OWNER_MISMATCH", status: 403 })
        );
    });

    it("requires an unexpired stored verified name", () => {
        expect(() => assertRewardOwnedByVerifiedSession(null, "alice.zelf", "zelf")).toThrow(
            expect.objectContaining({ code: "FACE_VERIFIED_TAG_REQUIRED", status: 403 })
        );
        expect(() => assertRewardOwnedByVerifiedSession("", "alice.zelf", "zelf")).toThrow(
            expect.objectContaining({ code: "FACE_VERIFIED_TAG_REQUIRED", status: 403 })
        );
    });

    it("allows one payout per name", () => {
        expect(firstTransactionClaimDecision(null)).toBe("create");
        expect(firstTransactionClaimDecision({ status: "claimed", payoutTx: "sig" })).toBe("already");
        expect(firstTransactionClaimDecision({ status: "pending", payoutTx: "" })).toBe("already");
        expect(firstTransactionClaimDecision({ status: "failed", payoutTx: "" })).toBe("retry");
    });
});

describe("staff authorization", () => {
    it("allows an admin of the same client to change a staff role", () => {
        const caller = { email: "owner@example.com" };
        expect(assertStaffRoleChangeAllowed(caller, "owner@example.com")).toBe("owner@example.com");
    });

    it("rejects a caller who is not an admin of the staff member's client", () => {
        expect(() => assertStaffRoleChangeAllowed({ email: "owner@example.com" }, "other@example.com")).toThrow(
            expect.objectContaining({ code: "STAFF_NOT_IN_CLIENT", status: 403 })
        );
        expect(() =>
            assertStaffRoleChangeAllowed(
                { accountType: "staff", role: "read", ownerEmail: "owner@example.com", email: "staff@example.com" },
                "owner@example.com"
            )
        ).toThrow(expect.objectContaining({ code: "STAFF_NOT_IN_CLIENT", status: 403 }));
    });

    it("saves a passkey only for the signed-in identity", () => {
        expect(assertPasskeyOwner({ email: "owner@example.com", phone: "+1555" }, { email: "owner@example.com" })).toEqual({
            email: "owner@example.com",
            phone: "+1555",
        });
        expect(() => assertPasskeyOwner({ email: "owner@example.com" }, { email: "other@example.com" })).toThrow(
            expect.objectContaining({ code: "PASSKEY_OWNER_MISMATCH", status: 403 })
        );
    });
});

describe("vault email registration owner", () => {
    const owner = "0x0000000000000000000000000000000000000001";
    const other = "0x0000000000000000000000000000000000000002";

    it("accepts the authenticated session wallet or an owner signature", () => {
        expect(resolveProvenVaultOwner({ sessionIdentifier: owner, expectedOwner: owner })).toBe(owner);
        expect(resolveProvenVaultOwner({ signerAddress: owner, sessionIdentifier: "install-id", expectedOwner: owner })).toBe(owner);
    });

    it("rejects a caller who does not prove the vault owner", () => {
        expect(() => resolveProvenVaultOwner({ sessionIdentifier: other, expectedOwner: owner })).toThrow(
            expect.objectContaining({ code: "VAULT_OWNER_MISMATCH", status: 403 })
        );
        expect(() => resolveProvenVaultOwner({ sessionIdentifier: "install-id" })).toThrow(
            expect.objectContaining({ code: "VAULT_OWNER_MISMATCH", status: 403 })
        );
    });
});

describe("lawyer preference owner", () => {
    it("requires an authenticated owner email", () => {
        expect(requirePreferencesOwner({ email: "lawyer@example.com" })).toBe("lawyer@example.com");
        expect(() => requirePreferencesOwner({})).toThrow(expect.objectContaining({ code: "OWNER_REQUIRED", status: 401 }));
        expect(() => requirePreferencesOwner({ email: undefined })).toThrow(expect.objectContaining({ code: "OWNER_REQUIRED" }));
    });
});

describe("protected IPFS key search", () => {
    const records = [
        { publicData: { accountEmail: "owner@example.com", type: "client_account" } },
        { publicData: { accountEmail: "other@example.com", type: "client_account" } },
    ];

    it("returns only the caller's records", () => {
        const visible = filterOwnedRecords(records, { email: "owner@example.com" });
        expect(visible).toHaveLength(1);
        expect(visible[0].publicData.accountEmail).toBe("owner@example.com");
    });

    it("returns every record for a super admin", () => {
        expect(filterOwnedRecords(records, { superAdminId: "admin-id", email: "owner@example.com" })).toHaveLength(2);
    });
});
