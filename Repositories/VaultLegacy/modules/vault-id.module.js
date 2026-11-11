/**
 * Normalize on-chain vault identifiers to a 32-byte hex string.
 * Shared by vault creation, email registration, and relay decoding.
 */

const normalizeVaultId = (vaultId) => {
    if (vaultId == null) return "";
    let hex;
    if (typeof vaultId === "bigint") {
        hex = vaultId.toString(16);
    } else {
        const s = String(vaultId).trim().toLowerCase();
        hex = s.startsWith("0x") ? s.slice(2) : s;
        if (!/^[0-9a-f]+$/i.test(hex)) {
            hex = BigInt(s).toString(16);
        }
    }
    return `0x${hex.padStart(64, "0")}`;
};

module.exports = { normalizeVaultId };
