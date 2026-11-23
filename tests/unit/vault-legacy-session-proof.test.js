const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const { ethers } = require("ethers");

const { TOKEN_TYPES } = require("../../Core/jwt-claims");
const { challenge, create } = require("../../Repositories/VaultLegacy/controllers/vault-legacy-session.controller");
const { iface } = require("../../Repositories/VaultLegacy/modules/vault-legacy-relay-policy.module");
const {
    _resetSessionProofState,
    buildSessionMessage,
    createChallenge,
    issueSession,
    sessionProofMode,
} = require("../../Repositories/VaultLegacy/modules/vault-legacy-session-proof.module");
const {
    _resetRelayGuard,
    assertVaultRole,
    assessCall,
    lookupVault,
    reserveRelay,
} = require("../../Repositories/VaultLegacy/modules/vault-legacy-relay-guard.module");

const SECRET = "unit-test-legacy-session-secret";
const INSTALLATION = "550e8400-e29b-41d4-a716-446655440000";
const VAULT_ID = `0x${"ab".repeat(32)}`;
const NOW = Date.parse("2026-11-23T12:00:00.000Z");

const ENV_KEYS = [
    "LEGACY_JWT_SECRET",
    "VAULT_LEGACY_SESSION_PROOF",
    "VAULT_LEGACY_PROVEN_SESSION_TTL_SECONDS",
    "VAULT_LEGACY_CHALLENGE_TTL_SECONDS",
    "VAULT_LEGACY_CHALLENGE_PER_IP_PER_MINUTE",
    "VAULT_LEGACY_SESSION_PER_IP_PER_MINUTE",
    "VAULT_LEGACY_RELAY_DAILY_CAP",
    "VAULT_LEGACY_RELAY_IP_DAILY_CAP",
];

const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const restoreEnv = () => {
    for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }
};

const ctxFor = (body, ip) => ({
    request: { body },
    state: {},
    status: 200,
    get(name) {
        if (String(name).toLowerCase() === "x-forwarded-for" && ip) return ip;
        return "";
    },
});

const signChallenge = async (wallet, issued) => {
    const sig = await wallet.signMessage(issued.message);
    return { sig, signedMessage: issued.message, address: wallet.address };
};

describe("vault-legacy session proof", () => {
    beforeEach(() => {
        restoreEnv();
        process.env.LEGACY_JWT_SECRET = SECRET;
        _resetSessionProofState();
        _resetRelayGuard();
    });

    afterAll(() => {
        restoreEnv();
    });

    test("legacy mode still issues a 24-hour token from an installation id", async () => {
        expect(sessionProofMode()).toBe("legacy");
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
        const ctx = ctxFor({ identifier: INSTALLATION }, "203.0.113.10");

        await create(ctx);

        expect(ctx.status).toBe(200);
        expect(ctx.body.proof).toBe("legacy");
        expect(ctx.body.expiresIn).toBe(60 * 60 * 24);
        const decoded = jwt.verify(ctx.body.token, SECRET);
        expect(decoded.typ).toBe(TOKEN_TYPES.vaultLegacy);
        expect(decoded.identifier).toBe(INSTALLATION);
        expect(decoded.proof).toBe("legacy");
        expect(decoded.ethAddress).toBeUndefined();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('"proof":"legacy"'));
        warn.mockRestore();
    });

    test("required mode rejects an installation id with no signature", async () => {
        process.env.VAULT_LEGACY_SESSION_PROOF = "required";
        const ctx = ctxFor({ identifier: INSTALLATION }, "203.0.113.11");

        await create(ctx);

        expect(ctx.status).toBe(401);
        expect(ctx.body).toEqual({ error: "SESSION_PROOF_REQUIRED", code: "SESSION_PROOF_REQUIRED" });
        expect(ctx.body.token).toBeUndefined();
    });

    test("a wallet signature over the server challenge binds the token to that address", async () => {
        process.env.VAULT_LEGACY_PROVEN_SESSION_TTL_SECONDS = "120";
        const wallet = ethers.Wallet.createRandom();
        const challengeCtx = ctxFor({ identifier: INSTALLATION, address: wallet.address.toLowerCase() }, "203.0.113.12");
        await challenge(challengeCtx);

        expect(challengeCtx.status).toBe(200);
        expect(challengeCtx.body.address).toBe(wallet.address);
        expect(challengeCtx.body.message).toBe(
            buildSessionMessage({
                identifier: INSTALLATION,
                address: wallet.address,
                nonce: challengeCtx.body.message.split("nonce: ")[1].split("\n")[0],
                expiresAtUnix: Number(challengeCtx.body.message.split("expires: ")[1]),
            })
        );

        const sessionCtx = ctxFor(
            {
                identifier: INSTALLATION,
                challengeId: challengeCtx.body.challengeId,
                authSig: await signChallenge(wallet, challengeCtx.body),
            },
            "203.0.113.12"
        );
        await create(sessionCtx);

        expect(sessionCtx.status).toBe(200);
        expect(sessionCtx.body.proof).toBe("eip191");
        expect(sessionCtx.body.expiresIn).toBe(120);
        expect(sessionCtx.body.address).toBe(wallet.address);
        const decoded = jwt.verify(sessionCtx.body.token, SECRET);
        expect(decoded.ethAddress).toBe(wallet.address);
        expect(decoded.identifier).toBe(INSTALLATION);
        expect(decoded.proof).toBe("eip191");
        expect(decoded.exp - decoded.iat).toBe(120);
    });

    test("a challenge is single-use and must match the identifier and the signing wallet", async () => {
        const wallet = ethers.Wallet.createRandom();
        const other = ethers.Wallet.createRandom();
        const issued = await createChallenge({
            body: { identifier: INSTALLATION, address: wallet.address },
            ip: "203.0.113.20",
            now: NOW,
        });
        const authSig = await signChallenge(wallet, issued);

        const first = await issueSession({
            body: { identifier: INSTALLATION, challengeId: issued.challengeId, authSig },
            ip: "203.0.113.20",
            now: NOW,
        });
        expect(first.address).toBe(wallet.address);

        await expect(
            issueSession({
                body: { identifier: INSTALLATION, challengeId: issued.challengeId, authSig },
                ip: "203.0.113.20",
                now: NOW,
            })
        ).rejects.toMatchObject({ code: "CHALLENGE_CONSUMED", status: 400 });

        const fresh = await createChallenge({
            body: { identifier: INSTALLATION, address: wallet.address },
            ip: "203.0.113.21",
            now: NOW,
        });
        await expect(
            issueSession({
                body: { identifier: "other-install", challengeId: fresh.challengeId, authSig: await signChallenge(wallet, fresh) },
                ip: "203.0.113.21",
                now: NOW,
            })
        ).rejects.toMatchObject({ code: "CHALLENGE_IDENTIFIER_MISMATCH", status: 400 });

        const mismatched = await createChallenge({
            body: { identifier: INSTALLATION, address: wallet.address },
            ip: "203.0.113.22",
            now: NOW,
        });
        await expect(
            issueSession({
                body: {
                    identifier: INSTALLATION,
                    challengeId: mismatched.challengeId,
                    authSig: await signChallenge(other, { message: mismatched.message }),
                },
                ip: "203.0.113.22",
                now: NOW,
            })
        ).rejects.toMatchObject({ code: "SESSION_ADDRESS_MISMATCH", status: 401 });
    });

    test("an expired challenge and a partial proof are rejected", async () => {
        const wallet = ethers.Wallet.createRandom();
        const issued = await createChallenge({
            body: { identifier: INSTALLATION, address: wallet.address },
            ip: "203.0.113.30",
            now: NOW,
            env: { ...process.env, VAULT_LEGACY_CHALLENGE_TTL_SECONDS: "30" },
        });

        await expect(
            issueSession({
                body: { identifier: INSTALLATION, challengeId: issued.challengeId, authSig: await signChallenge(wallet, issued) },
                ip: "203.0.113.30",
                now: NOW + 31 * 1000,
                env: process.env,
            })
        ).rejects.toMatchObject({ code: "CHALLENGE_EXPIRED", status: 400 });

        await expect(
            issueSession({
                body: { identifier: INSTALLATION, challengeId: issued.challengeId },
                ip: "203.0.113.31",
                now: NOW,
            })
        ).rejects.toMatchObject({ code: "SESSION_PROOF_INCOMPLETE", status: 400 });
    });

    test("an address identifier must be the wallet that signs", async () => {
        const wallet = ethers.Wallet.createRandom();
        const other = ethers.Wallet.createRandom();

        await expect(
            createChallenge({
                body: { identifier: wallet.address, address: other.address },
                ip: "203.0.113.40",
                now: NOW,
            })
        ).rejects.toMatchObject({ code: "SESSION_ADDRESS_MISMATCH", status: 400 });
    });

    test("challenge issuance is limited per client address", async () => {
        const wallet = ethers.Wallet.createRandom();
        const env = { ...process.env, VAULT_LEGACY_CHALLENGE_PER_IP_PER_MINUTE: "2" };
        const body = { identifier: INSTALLATION, address: wallet.address };

        await createChallenge({ body, ip: "203.0.113.50", now: NOW, env });
        await createChallenge({ body, ip: "203.0.113.50", now: NOW, env });
        await expect(createChallenge({ body, ip: "203.0.113.50", now: NOW, env })).rejects.toMatchObject({
            code: "CHALLENGE_RATE_LIMITED",
            status: 429,
        });
        await createChallenge({ body, ip: "203.0.113.51", now: NOW, env });
    });

    test("the challenge route is registered next to session issuance", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "../../Repositories/VaultLegacy/routes/vault-legacy.routes.js"),
            "utf8"
        );
        expect(source).toContain("`${PATH}/sessions/challenge`, SessionController.challenge");
    });
});

describe("vault-legacy relay identity and daily caps", () => {
    const owner = ethers.Wallet.createRandom().address;
    const lawyer = ethers.Wallet.createRandom().address;
    const beneficiary = ethers.Wallet.createRandom().address;
    const proven = (address, identifier = INSTALLATION) => ({
        typ: TOKEN_TYPES.vaultLegacy,
        identifier,
        proof: "eip191",
        ethAddress: address,
    });

    beforeEach(() => {
        restoreEnv();
        _resetRelayGuard();
    });

    test("a legacy session is not tied to a vault role", () => {
        const calldata = iface.encodeFunctionData("updateHeartbeat", [VAULT_ID]);
        const decoded = iface.parseTransaction({ data: calldata });
        const verdict = assessCall({
            legacyUser: { typ: TOKEN_TYPES.vaultLegacy, identifier: INSTALLATION, proof: "legacy" },
            fnName: "updateHeartbeat",
            decoded,
        });

        expect(verdict).toEqual({ legacy: true, enforce: false, fnName: "updateHeartbeat", needsVault: false });
    });

    test("required mode rejects a session that has no proven wallet", () => {
        const calldata = iface.encodeFunctionData("updateHeartbeat", [VAULT_ID]);
        const decoded = iface.parseTransaction({ data: calldata });

        expect(() =>
            assessCall({
                legacyUser: { typ: TOKEN_TYPES.vaultLegacy, identifier: INSTALLATION, proof: "legacy" },
                fnName: "updateHeartbeat",
                decoded,
                env: { VAULT_LEGACY_SESSION_PROOF: "required" },
            })
        ).toThrow(expect.objectContaining({ code: "RELAY_IDENTITY_REQUIRED", status: 403 }));
    });

    test("createVault must name the proven wallet as owner", () => {
        const calldata = iface.encodeFunctionData("createVault", [
            owner,
            VAULT_ID,
            [beneficiary],
            lawyer,
            1,
            2592000,
            "cid",
            "cid-validator",
        ]);
        const decoded = iface.parseTransaction({ data: calldata });
        const allowed = assessCall({ legacyUser: proven(owner), fnName: "createVault", decoded });
        expect(allowed.needsVault).toBe(false);

        const foreign = iface.parseTransaction({
            data: iface.encodeFunctionData("createVault", [lawyer, VAULT_ID, [beneficiary], lawyer, 1, 2592000, "cid", "cid-validator"]),
        });
        expect(() => assessCall({ legacyUser: proven(owner), fnName: "createVault", decoded: foreign })).toThrow(
            expect.objectContaining({ code: "RELAY_IDENTITY_MISMATCH", status: 403 })
        );
    });

    test("owner, lawyer, and beneficiary calls must match the proven wallet", () => {
        const vault = { exists: true, owner, lawyer, beneficiaries: [beneficiary] };
        const heartbeat = iface.parseTransaction({ data: iface.encodeFunctionData("updateHeartbeat", [VAULT_ID]) });
        const accept = iface.parseTransaction({ data: iface.encodeFunctionData("acceptVault", [VAULT_ID]) });
        const execute = iface.parseTransaction({ data: iface.encodeFunctionData("executeVault", [VAULT_ID, beneficiary]) });

        const ownerCall = assessCall({ legacyUser: proven(owner), fnName: "updateHeartbeat", decoded: heartbeat });
        expect(() => assertVaultRole(ownerCall, vault)).not.toThrow();
        expect(() => assertVaultRole(ownerCall, { ...vault, owner: lawyer })).toThrow(
            expect.objectContaining({ code: "RELAY_IDENTITY_MISMATCH" })
        );

        const lawyerCall = assessCall({ legacyUser: proven(lawyer), fnName: "acceptVault", decoded: accept });
        expect(() => assertVaultRole(lawyerCall, vault)).not.toThrow();
        expect(() => assertVaultRole(lawyerCall, { ...vault, lawyer: owner })).toThrow(
            expect.objectContaining({ code: "RELAY_IDENTITY_MISMATCH" })
        );

        const beneficiaryCall = assessCall({ legacyUser: proven(beneficiary), fnName: "executeVault", decoded: execute });
        expect(() => assertVaultRole(beneficiaryCall, vault)).not.toThrow();
        expect(() => assertVaultRole(beneficiaryCall, { ...vault, beneficiaries: [owner] })).toThrow(
            expect.objectContaining({ code: "RELAY_IDENTITY_MISMATCH" })
        );
        expect(() => assertVaultRole(beneficiaryCall, { exists: false, owner, lawyer, beneficiaries: [] })).toThrow(
            expect.objectContaining({ code: "RELAY_VAULT_UNVERIFIED" })
        );
    });

    test("lookupVault reads the registry vault tuple", async () => {
        const tuple = [VAULT_ID, owner, [beneficiary], lawyer, 1, 30, 1, 1, 1, "cid", "cid-validator", true, 1, 0];
        const raw = iface.encodeFunctionResult("getVault", [tuple]);
        const provider = { call: async () => raw };
        const vault = await lookupVault(provider, owner, VAULT_ID);

        expect(vault.exists).toBe(true);
        expect(vault.owner).toBe(owner);
        expect(vault.lawyer).toBe(lawyer);
        expect(vault.beneficiaries).toEqual([beneficiary]);
        await expect(lookupVault({ call: async () => { throw new Error("rpc"); } }, owner, VAULT_ID)).resolves.toBeUndefined();
    });

    test("daily caps apply per proven wallet and per client address", async () => {
        const env = { VAULT_LEGACY_RELAY_DAILY_CAP: "1", VAULT_LEGACY_RELAY_IP_DAILY_CAP: "5" };
        const user = proven(owner, "install-a");

        await reserveRelay({ legacyUser: user, ip: "203.0.113.60", env, now: NOW });
        await expect(reserveRelay({ legacyUser: proven(owner, "install-b"), ip: "203.0.113.61", env, now: NOW })).rejects.toMatchObject({
            code: "RELAY_DAILY_CAP_EXCEEDED",
            status: 429,
        });
        await reserveRelay({
            legacyUser: proven(owner, "install-a"),
            ip: "203.0.113.60",
            env,
            now: Date.parse("2026-11-24T00:30:00.000Z"),
        });

        const ipEnv = { VAULT_LEGACY_RELAY_DAILY_CAP: "10", VAULT_LEGACY_RELAY_IP_DAILY_CAP: "1" };
        await reserveRelay({ legacyUser: proven(owner, "install-a"), ip: "203.0.113.70", env: ipEnv, now: NOW });
        await expect(
            reserveRelay({ legacyUser: proven(lawyer, "install-c"), ip: "203.0.113.70", env: ipEnv, now: NOW })
        ).rejects.toMatchObject({ code: "RELAY_IP_DAILY_CAP_EXCEEDED", status: 429 });
    });
});
