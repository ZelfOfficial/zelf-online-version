/**
 * Constraints for POST /api/vault-legacy/relay/send-tx.
 *
 * The Android and iOS inheritance WebView builds the calldata and asks the
 * relayer to submit it. The relayer signs only a vault-registry call: a
 * configured registry address, one of the vault methods the apps use, a zero
 * value, and a gas ceiling.
 */

const path = require("path");
const { ethers } = require("ethers");
const { TOKEN_TYPES } = require("../../../Core/jwt-claims");

const artifact = require(path.join(__dirname, "../contracts/VaultRegistry.json"));
const iface = new ethers.Interface(artifact.abi);

/** Vault methods the inheritance apps relay. Admin and upgrade methods are excluded. */
const ALLOWED_FUNCTIONS = Object.freeze([
    "acceptVault",
    "cancelVault",
    "changeLawyer",
    "confirmDeath",
    "createVault",
    "executeVault",
    "rejectVault",
    "updateHeartbeat",
]);

const allowedSelectors = new Map(
    ALLOWED_FUNCTIONS.map((name) => {
        const fragment = iface.getFunction(name);
        return [fragment.selector.toLowerCase(), name];
    })
);

/** Buffered gas limit the relayer will attach. Above this the call is refused. */
const MAX_GAS_LIMIT = 2_000_000n;
/** Avalanche C-Chain fees are normally a few tens of gwei. */
const MAX_FEE_PER_GAS = 500n * 10n ** 9n;
const MAX_PRIORITY_FEE_PER_GAS = 50n * 10n ** 9n;

const relayError = (code, status) => {
    const error = new Error(code);
    error.code = code;
    error.status = status;
    return error;
};

const configuredRegistryAddresses = (env = process.env) => {
    const raw = [env.LEGACY_VAULT_REGISTRY_ADDRESS, env.LEGACY_VAULT_REGISTRY_ADDRESSES]
        .flatMap((value) => String(value || "").split(/[\s,]+/))
        .map((value) => value.trim())
        .filter(Boolean);

    const addresses = [];
    for (const value of raw) {
        if (!ethers.isAddress(value)) continue;
        const checksum = ethers.getAddress(value);
        if (checksum === ethers.ZeroAddress) continue;
        if (!addresses.includes(checksum)) addresses.push(checksum);
    }
    return addresses;
};

/**
 * The bearer token issued by POST /api/vault-legacy/sessions.
 * @param {object|null|undefined} legacyUser
 */
const assertRelaySession = (legacyUser) => {
    if (!legacyUser || typeof legacyUser !== "object") {
        throw relayError("MISSING_AUTHORIZATION", 401);
    }
    if (legacyUser.typ !== TOKEN_TYPES.vaultLegacy) {
        throw relayError("INVALID_TOKEN_TYPE", 401);
    }
    if (typeof legacyUser.identifier !== "string" || legacyUser.identifier.trim() === "") {
        throw relayError("INVALID_TOKEN", 401);
    }
};

const assertZeroValue = (value) => {
    if (value == null || value === "") return;

    let parsed;
    try {
        if (typeof value === "bigint") {
            parsed = value;
        } else if (typeof value === "number") {
            if (!Number.isSafeInteger(value)) throw new Error("not an integer");
            parsed = BigInt(value);
        } else {
            parsed = BigInt(String(value).trim());
        }
    } catch (_error) {
        throw relayError("RELAY_VALUE_NOT_ALLOWED", 400);
    }

    if (parsed !== 0n) throw relayError("RELAY_VALUE_NOT_ALLOWED", 400);
};

/**
 * @returns {{ to: string, data: string, value: bigint, fnName: string, decoded: import("ethers").TransactionDescription }}
 */
const normalizeRelayTransaction = (input = {}, env = process.env) => {
    const to = input.to;
    const calldata = input.calldata;
    if (!to || !calldata) throw relayError("RELAY_FIELDS_REQUIRED", 400);

    const targets = configuredRegistryAddresses(env);
    if (targets.length === 0) throw relayError("RELAY_NOT_CONFIGURED", 503);

    if (typeof to !== "string" || !ethers.isAddress(to)) {
        throw relayError("RELAY_TARGET_NOT_ALLOWED", 400);
    }
    const checksum = ethers.getAddress(to);
    if (!targets.includes(checksum)) throw relayError("RELAY_TARGET_NOT_ALLOWED", 400);

    assertZeroValue(input.value);

    if (typeof calldata !== "string" || !/^0x[0-9a-fA-F]+$/.test(calldata) || calldata.length < 10) {
        throw relayError("RELAY_CALLDATA_INVALID", 400);
    }

    const fnName = allowedSelectors.get(calldata.slice(0, 10).toLowerCase());
    if (!fnName) throw relayError("RELAY_SELECTOR_NOT_ALLOWED", 400);

    let decoded;
    try {
        decoded = iface.parseTransaction({ data: calldata });
    } catch (_error) {
        throw relayError("RELAY_CALLDATA_INVALID", 400);
    }
    if (!decoded || decoded.name !== fnName) throw relayError("RELAY_CALLDATA_INVALID", 400);

    return { to: checksum, data: calldata, value: 0n, fnName, decoded };
};

const relayGasFromEstimate = (estimate, feeData = {}) => {
    if (typeof estimate !== "bigint" || estimate <= 0n || estimate > MAX_GAS_LIMIT) {
        throw relayError("RELAY_GAS_LIMIT_EXCEEDED", 400);
    }

    const gasLimit = estimate + estimate / 5n + 25_000n;
    if (gasLimit > MAX_GAS_LIMIT) throw relayError("RELAY_GAS_LIMIT_EXCEEDED", 400);

    const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? null;
    if (typeof maxFeePerGas !== "bigint" || maxFeePerGas <= 0n || maxFeePerGas > MAX_FEE_PER_GAS) {
        throw relayError("RELAY_FEE_CAP_EXCEEDED", 503);
    }

    let maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? 0n;
    if (typeof maxPriorityFeePerGas !== "bigint" || maxPriorityFeePerGas < 0n || maxPriorityFeePerGas > MAX_PRIORITY_FEE_PER_GAS) {
        throw relayError("RELAY_FEE_CAP_EXCEEDED", 503);
    }
    if (maxPriorityFeePerGas > maxFeePerGas) maxPriorityFeePerGas = maxFeePerGas;

    return { gasLimit, maxFeePerGas, maxPriorityFeePerGas };
};

const resolveRelayGas = async (provider, wallet, tx) => {
    let estimate;
    let feeData;
    try {
        [estimate, feeData] = await Promise.all([wallet.estimateGas(tx), provider.getFeeData()]);
    } catch (_error) {
        throw relayError("RELAY_GAS_ESTIMATE_FAILED", 400);
    }
    return relayGasFromEstimate(estimate, feeData);
};

const RELAY_CLIENT_CODES = new Set([
    "MISSING_AUTHORIZATION",
    "INVALID_TOKEN",
    "INVALID_TOKEN_TYPE",
    "RELAY_FIELDS_REQUIRED",
    "RELAY_NOT_CONFIGURED",
    "RELAY_TARGET_NOT_ALLOWED",
    "RELAY_VALUE_NOT_ALLOWED",
    "RELAY_CALLDATA_INVALID",
    "RELAY_SELECTOR_NOT_ALLOWED",
    "RELAY_GAS_LIMIT_EXCEEDED",
    "RELAY_FEE_CAP_EXCEEDED",
    "RELAY_GAS_ESTIMATE_FAILED",
]);

module.exports = {
    ALLOWED_FUNCTIONS,
    MAX_FEE_PER_GAS,
    MAX_GAS_LIMIT,
    MAX_PRIORITY_FEE_PER_GAS,
    RELAY_CLIENT_CODES,
    assertRelaySession,
    configuredRegistryAddresses,
    iface,
    normalizeRelayTransaction,
    relayError,
    relayGasFromEstimate,
    resolveRelayGas,
};
