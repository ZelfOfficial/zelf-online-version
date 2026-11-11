const { Address } = require("@ton/core");
const { getAddress } = require("ethers");

/** EQ, UQ and raw addresses identify the same mainnet account. */
const tonAddressLookupValues = (value) => {
    const address = Address.parse(String(value).trim());
    return [...new Set([
        String(value).trim(),
        address.toString({ bounceable: true, testOnly: false, urlSafe: true }),
        address.toString({ bounceable: false, testOnly: false, urlSafe: true }),
        address.toRawString(),
    ])];
};

const EVM_ADDRESS_KEYS = new Set(["ethAddress", "evmAddress", "avalancheAddress"]);

/**
 * Registry stores and filters are exact-match, and records hold the EIP-55 checksum.
 * Android derives a lowercase address from the seed, so the recovery lookup found
 * nothing and offered to pick a new Zelf ID (#562).
 */
const evmAddressLookupValues = (value) => {
    const trimmed = String(value).trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return [trimmed];

    return [...new Set([trimmed, getAddress(trimmed.toLowerCase()), trimmed.toLowerCase()])];
};

const addressLookupValues = (key, value) => {
    if (key === "tonAddress") return tonAddressLookupValues(value);
    if (EVM_ADDRESS_KEYS.has(key)) return evmAddressLookupValues(value);
    return [value];
};

module.exports = { addressLookupValues, evmAddressLookupValues, tonAddressLookupValues };
