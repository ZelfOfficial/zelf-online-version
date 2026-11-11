const mockGetVault = jest.fn();

jest.mock("../../Repositories/VaultLegacy/modules/avalanche-legacy.module", () =>
    jest.fn().mockImplementation(() => ({
        getVault: (...args) => mockGetVault(...args),
    }))
);

const { ethers } = require("ethers");
const { assertCanRegisterVaultEmails } = require("../../Repositories/VaultLegacy/modules/vault-legacy.module");

const vaultId = `0x${"ab".repeat(32)}`;

const signOwner = async (wallet, id = vaultId) => {
    const signedMessage = `ZelfLegacy register-emails ${id}`;
    const sig = await wallet.signMessage(signedMessage);
    return { sig, signedMessage, address: wallet.address };
};

beforeEach(() => {
    mockGetVault.mockReset();
});

describe("vault register-emails owner", () => {
    test("accepts a signature from the on-chain owner", async () => {
        const owner = ethers.Wallet.createRandom();
        mockGetVault.mockResolvedValue({ exists: true, owner: owner.address });

        const proven = await assertCanRegisterVaultEmails({
            vaultId,
            authSig: await signOwner(owner),
            legacyUser: { identifier: "install-1" },
        });

        expect(proven).toBe(owner.address);
    });

    test("accepts the authenticated session wallet when it owns the vault", async () => {
        const owner = ethers.Wallet.createRandom();
        mockGetVault.mockResolvedValue({ exists: true, owner: owner.address });

        const proven = await assertCanRegisterVaultEmails({
            vaultId,
            legacyUser: { identifier: owner.address },
        });

        expect(proven).toBe(owner.address);
    });

    test("rejects a different signer", async () => {
        const owner = ethers.Wallet.createRandom();
        const other = ethers.Wallet.createRandom();
        mockGetVault.mockResolvedValue({ exists: true, owner: owner.address });

        await expect(
            assertCanRegisterVaultEmails({
                vaultId,
                authSig: await signOwner(other),
                legacyUser: { identifier: other.address },
            })
        ).rejects.toMatchObject({ status: 403, code: "VAULT_OWNER_MISMATCH" });
    });

    test("rejects a session that does not prove ownership before the vault exists", async () => {
        mockGetVault.mockResolvedValue({ exists: false, owner: ethers.ZeroAddress });

        await expect(
            assertCanRegisterVaultEmails({
                vaultId,
                legacyUser: { identifier: "install-1" },
            })
        ).rejects.toMatchObject({ code: "VAULT_OWNER_MISMATCH" });
    });

    test("accepts the owner signature before the vault is on chain and keeps that owner", async () => {
        const owner = ethers.Wallet.createRandom();
        const other = ethers.Wallet.createRandom();
        mockGetVault.mockResolvedValue({ exists: false, owner: ethers.ZeroAddress });

        const proven = await assertCanRegisterVaultEmails({
            vaultId,
            authSig: await signOwner(owner),
            legacyUser: { identifier: "install-1" },
        });
        expect(proven).toBe(owner.address);

        await expect(
            assertCanRegisterVaultEmails({
                vaultId,
                authSig: await signOwner(other),
                legacyUser: { identifier: "install-2" },
                existing: { ownerAddress: owner.address },
            })
        ).rejects.toMatchObject({ code: "VAULT_OWNER_MISMATCH" });
    });
});
