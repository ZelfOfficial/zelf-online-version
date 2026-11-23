const { ethers } = require("ethers");
const {
    ALLOWED_FUNCTIONS,
    MAX_GAS_LIMIT,
    assertRelaySession,
    iface,
    normalizeRelayTransaction,
    relayGasFromEstimate,
} = require("../../Repositories/VaultLegacy/modules/vault-legacy-relay-policy.module");

const REGISTRY = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const VAULT_ID = `0x${"ab".repeat(32)}`;

const fee = {
    maxFeePerGas: 25n * 10n ** 9n,
    maxPriorityFeePerGas: 1n * 10n ** 9n,
};

const envWith = (address = REGISTRY) => ({
    LEGACY_VAULT_REGISTRY_ADDRESS: address,
});

describe("vault-legacy relay policy", () => {
    test("rejects a call with no vault-legacy session", () => {
        expect(() => assertRelaySession(null)).toThrow(
            expect.objectContaining({ code: "MISSING_AUTHORIZATION", status: 401 })
        );
        expect(() => assertRelaySession({ typ: "session", identifier: "device" })).toThrow(
            expect.objectContaining({ code: "INVALID_TOKEN_TYPE", status: 401 })
        );
    });

    test("rejects a target outside the configured registry and a non-zero value", () => {
        const calldata = iface.encodeFunctionData("updateHeartbeat", [VAULT_ID]);

        expect(() =>
            normalizeRelayTransaction({ to: OTHER, calldata, value: "0x0" }, envWith())
        ).toThrow(expect.objectContaining({ code: "RELAY_TARGET_NOT_ALLOWED", status: 400 }));

        expect(() =>
            normalizeRelayTransaction({ to: REGISTRY, calldata, value: "0x1" }, envWith())
        ).toThrow(expect.objectContaining({ code: "RELAY_VALUE_NOT_ALLOWED", status: 400 }));

        const admin = iface.encodeFunctionData("setRelayer", [OTHER]);
        expect(() => normalizeRelayTransaction({ to: REGISTRY, calldata: admin }, envWith())).toThrow(
            expect.objectContaining({ code: "RELAY_SELECTOR_NOT_ALLOWED", status: 400 })
        );
    });

    test("accepts a vault method to the configured registry with value zero", () => {
        const calldata = iface.encodeFunctionData("updateHeartbeat", [VAULT_ID]);
        const normalized = normalizeRelayTransaction(
            { to: REGISTRY.toLowerCase(), calldata, value: "0x0" },
            envWith()
        );

        expect(normalized.to).toBe(ethers.getAddress(REGISTRY));
        expect(normalized.value).toBe(0n);
        expect(normalized.fnName).toBe("updateHeartbeat");
        expect(normalized.data.slice(0, 10).toLowerCase()).toBe(iface.getFunction("updateHeartbeat").selector);
        expect(ALLOWED_FUNCTIONS).toEqual(
            expect.arrayContaining(["createVault", "updateHeartbeat", "executeVault", "confirmDeath"])
        );
    });

    test("refuses a gas estimate above the cap", () => {
        expect(() => relayGasFromEstimate(MAX_GAS_LIMIT, fee)).toThrow(
            expect.objectContaining({ code: "RELAY_GAS_LIMIT_EXCEEDED" })
        );

        const gas = relayGasFromEstimate(100_000n, fee);
        expect(gas.gasLimit).toBeLessThanOrEqual(MAX_GAS_LIMIT);
        expect(gas.value).toBeUndefined();
    });
});
