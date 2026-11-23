const REGISTRY = "0x1111111111111111111111111111111111111111";
const ORIGINAL = {
    LEGACY_JWT_SECRET: process.env.LEGACY_JWT_SECRET,
    LEGACY_RELAYER_PRIVATE_KEY: process.env.LEGACY_RELAYER_PRIVATE_KEY,
    LEGACY_VAULT_REGISTRY_ADDRESS: process.env.LEGACY_VAULT_REGISTRY_ADDRESS,
};

const LEGACY_SECRET = "unit-test-legacy-jwt-secret";
process.env.LEGACY_JWT_SECRET = LEGACY_SECRET;
process.env.LEGACY_RELAYER_PRIVATE_KEY = "unit-test-relayer-key";
process.env.LEGACY_VAULT_REGISTRY_ADDRESS = REGISTRY;

const mockSendTransaction = jest.fn();
const mockEstimateGas = jest.fn();
const mockGetFeeData = jest.fn();

jest.mock("ethers", () => {
    const actual = jest.requireActual("ethers");
    function Wallet() {
        return {
            address: "0x3333333333333333333333333333333333333333",
            estimateGas: (...args) => mockEstimateGas(...args),
            sendTransaction: (...args) => mockSendTransaction(...args),
        };
    }
    function JsonRpcProvider() {
        return { getFeeData: (...args) => mockGetFeeData(...args) };
    }
    return {
        ...actual,
        Wallet,
        JsonRpcProvider,
        ethers: { ...actual.ethers, Wallet, JsonRpcProvider },
    };
});

jest.mock("../../Repositories/VaultLegacy/modules/vault-legacy-relayer.module", () => ({
    getRelayerHealth: jest.fn(async () => ({})),
    assertRelayerMatchesContract: jest.fn(async () => {}),
}));

jest.mock("../../Repositories/VaultLegacy/modules/vault-legacy-demo.module", () => ({
    normalizeVaultId: (value) => value,
    isDemoLawyerAddress: () => false,
}));

jest.mock("../../Repositories/VaultLegacy/modules/vault-legacy.module", () => ({
    assertCanRegisterVaultEmails: jest.fn(),
}));

jest.mock("../../Repositories/VaultLegacy/models/vault-legacy.model", () => ({
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
}));

jest.mock("../../Repositories/VaultLegacy/modules/email", () => ({
    sendLawyerNewPlan: jest.fn(),
    sendTestatorPlanActive: jest.fn(),
}));

jest.mock("../../Repositories/IPFS/modules/ipfs.module", () => ({
    insert: jest.fn(),
}));

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { signToken, TOKEN_TYPES } = require("../../Core/jwt-claims");
const { requireJWT } = require("../../Repositories/VaultLegacy/middlewares/vault-legacy.middleware");
const { sendTx } = require("../../Repositories/VaultLegacy/controllers/vault-legacy-relay.controller");
const { iface } = require("../../Repositories/VaultLegacy/modules/vault-legacy-relay-policy.module");
const { _resetRelayGuard } = require("../../Repositories/VaultLegacy/modules/vault-legacy-relay-guard.module");

const VAULT_ID = `0x${"cd".repeat(32)}`;
const calldata = iface.encodeFunctionData("updateHeartbeat", [VAULT_ID]);

const sessionUser = { typ: TOKEN_TYPES.vaultLegacy, identifier: "install-1" };

const ctxFor = (body, legacyUser = sessionUser) => ({
    headers: {},
    request: { body },
    state: legacyUser ? { legacyUser } : {},
    status: 200,
});

describe("vault-legacy relay send-tx", () => {
    afterAll(() => {
        process.env.LEGACY_JWT_SECRET = ORIGINAL.LEGACY_JWT_SECRET;
        process.env.LEGACY_RELAYER_PRIVATE_KEY = ORIGINAL.LEGACY_RELAYER_PRIVATE_KEY;
        process.env.LEGACY_VAULT_REGISTRY_ADDRESS = ORIGINAL.LEGACY_VAULT_REGISTRY_ADDRESS;
    });

    beforeEach(() => {
        process.env.LEGACY_VAULT_REGISTRY_ADDRESS = REGISTRY;
        delete process.env.VAULT_LEGACY_SESSION_PROOF;
        delete process.env.VAULT_LEGACY_RELAY_DAILY_CAP;
        delete process.env.VAULT_LEGACY_RELAY_IP_DAILY_CAP;
        _resetRelayGuard();
        mockSendTransaction.mockReset();
        mockEstimateGas.mockReset();
        mockGetFeeData.mockReset();
        mockEstimateGas.mockResolvedValue(180_000n);
        mockGetFeeData.mockResolvedValue({
            maxFeePerGas: 25n * 10n ** 9n,
            maxPriorityFeePerGas: 1n * 10n ** 9n,
        });
        mockSendTransaction.mockResolvedValue({
            hash: `0x${"ab".repeat(32)}`,
            wait: jest.fn(async () => ({ blockNumber: 9 })),
        });
    });

    test("the route keeps the vault-legacy session check", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "../../Repositories/VaultLegacy/routes/vault-legacy.routes.js"),
            "utf8"
        );
        expect(source).toContain("`${RELAY_PATH}/send-tx`, requireJWT, RelayController.sendTx");
    });

    test("rejects an unauthenticated call", async () => {
        const ctx = ctxFor({ to: REGISTRY, calldata }, null);
        await sendTx(ctx);

        expect(ctx.status).toBe(401);
        expect(ctx.body).toEqual({ error: "MISSING_AUTHORIZATION", code: "MISSING_AUTHORIZATION" });
        expect(mockSendTransaction).not.toHaveBeenCalled();
    });

    test("requireJWT rejects a missing bearer token", async () => {
        const ctx = { headers: {}, state: {} };
        const next = jest.fn();
        await requireJWT(ctx, next);

        expect(ctx.status).toBe(401);
        expect(ctx.body.code).toBe("MISSING_AUTHORIZATION");
        expect(next).not.toHaveBeenCalled();
    });

    test("requireJWT accepts a vault-legacy session token", async () => {
        const token = signToken({ identifier: "install-1", type: "vault-legacy" }, LEGACY_SECRET, {
            typ: TOKEN_TYPES.vaultLegacy,
            expiresIn: 60,
        });
        const ctx = { headers: { authorization: `Bearer ${token}` }, state: {} };
        const next = jest.fn();
        await requireJWT(ctx, next);

        expect(next).toHaveBeenCalled();
        expect(ctx.state.legacyUser.identifier).toBe("install-1");
        expect(ctx.state.legacyUser.typ).toBe(TOKEN_TYPES.vaultLegacy);
    });

    test("rejects a non-allowlisted target and a non-zero value without sending", async () => {
        const foreign = await ctxFor({ to: "0x2222222222222222222222222222222222222222", calldata, value: "0x0" });
        await sendTx(foreign);
        expect(foreign.status).toBe(400);
        expect(foreign.body.code).toBe("RELAY_TARGET_NOT_ALLOWED");

        const valued = await ctxFor({ to: REGISTRY, calldata, value: "0x1" });
        await sendTx(valued);
        expect(valued.status).toBe(400);
        expect(valued.body.code).toBe("RELAY_VALUE_NOT_ALLOWED");
        expect(mockSendTransaction).not.toHaveBeenCalled();
    });

    test("sends an allowed vault call with value zero and a capped gas limit", async () => {
        const ctx = ctxFor({ to: REGISTRY, calldata });
        await sendTx(ctx);

        expect(ctx.status).toBe(200);
        expect(ctx.body).toEqual(expect.objectContaining({ txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) }));
        expect(mockSendTransaction).toHaveBeenCalledTimes(1);
        const tx = mockSendTransaction.mock.calls[0][0];
        expect(tx.to).toBe(ethers.getAddress(REGISTRY));
        expect(tx.data).toBe(calldata);
        expect(tx.value).toBe(0n);
        expect(tx.gasLimit).toBeLessThanOrEqual(2_000_000n);
        expect(tx.maxFeePerGas).toBeLessThanOrEqual(500n * 10n ** 9n);
    });

    test("rejects a proven session whose wallet is not the createVault owner", async () => {
        const owner = "0x4444444444444444444444444444444444444444";
        const other = "0x5555555555555555555555555555555555555555";
        const createCalldata = iface.encodeFunctionData("createVault", [
            other,
            VAULT_ID,
            [other],
            other,
            1,
            2592000,
            "cid",
            "cid-validator",
        ]);
        const ctx = ctxFor(
            { to: REGISTRY, calldata: createCalldata },
            { typ: TOKEN_TYPES.vaultLegacy, identifier: "install-1", proof: "eip191", ethAddress: owner }
        );

        await sendTx(ctx);

        expect(ctx.status).toBe(403);
        expect(ctx.body.code).toBe("RELAY_IDENTITY_MISMATCH");
        expect(mockSendTransaction).not.toHaveBeenCalled();
    });

    test("stops after the daily identity cap without sending another transaction", async () => {
        process.env.VAULT_LEGACY_RELAY_DAILY_CAP = "1";
        const first = ctxFor({ to: REGISTRY, calldata });
        await sendTx(first);
        expect(first.status).toBe(200);

        const second = ctxFor({ to: REGISTRY, calldata });
        await sendTx(second);

        expect(second.status).toBe(429);
        expect(second.body).toEqual({ error: "RELAY_DAILY_CAP_EXCEEDED", code: "RELAY_DAILY_CAP_EXCEEDED" });
        expect(mockSendTransaction).toHaveBeenCalledTimes(1);
    });
});
