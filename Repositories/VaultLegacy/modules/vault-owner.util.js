const { ethers } = require("ethers");

const VAULT_OWNER_MISMATCH = "VAULT_OWNER_MISMATCH";

const vaultOwnerMismatch = () => {
    const error = new Error(VAULT_OWNER_MISMATCH);
    error.status = 403;
    error.code = VAULT_OWNER_MISMATCH;
    return error;
};

const checksumAddress = (value) => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
        return ethers.getAddress(trimmed);
    } catch {
        return null;
    }
};

const sameAddress = (left, right) => {
    if (!left || !right) return false;
    return left.toLowerCase() === right.toLowerCase();
};

/**
 * The caller is the vault owner when the authenticated session wallet is that address
 * or when an owner-address signature recovers to that address.
 * On the first write there is no expected owner yet, so the proven address is stored.
 */
const resolveProvenVaultOwner = ({ sessionIdentifier, signerAddress, expectedOwner } = {}) => {
    const sessionWallet = checksumAddress(sessionIdentifier);
    const signer = checksumAddress(signerAddress);
    const expected = checksumAddress(expectedOwner);

    if (signer && expected && !sameAddress(signer, expected)) {
        throw vaultOwnerMismatch();
    }

    if (!signer && sessionWallet && expected && !sameAddress(sessionWallet, expected)) {
        throw vaultOwnerMismatch();
    }

    if (expected) {
        if (signer && sameAddress(signer, expected)) return signer;
        if (sessionWallet && sameAddress(sessionWallet, expected)) return sessionWallet;
        throw vaultOwnerMismatch();
    }

    if (signer) return signer;
    if (sessionWallet) return sessionWallet;

    throw vaultOwnerMismatch();
};

module.exports = {
    VAULT_OWNER_MISMATCH,
    checksumAddress,
    resolveProvenVaultOwner,
};
