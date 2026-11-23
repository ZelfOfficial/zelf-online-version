/**
 * Binds a vault-legacy relay call to the wallet that proved the session,
 * and counts relayed transactions per identity and per client address.
 *
 * Legacy sessions (no EIP-191 proof) stay allowed while
 * VAULT_LEGACY_SESSION_PROOF=legacy. Required mode rejects them.
 */

const { ethers } = require("ethers");
const mongoose = require("mongoose");

const { clientIp } = require("../../../Core/access-log");
const LegacyDemo = require("./vault-legacy-demo.module");
const { iface, relayError } = require("./vault-legacy-relay-policy.module");
const { sessionProofMode } = require("./vault-legacy-session-proof.module");
const Usage = require("../models/vault-legacy-relay-usage.model");

const DEFAULT_IDENTITY_DAILY_CAP = 20;
const DEFAULT_IP_DAILY_CAP = 200;
const USAGE_KEEP_MS = 3 * 24 * 60 * 60 * 1000;

const OWNER_FUNCTIONS = new Set(["updateHeartbeat", "cancelVault", "changeLawyer"]);
const LAWYER_FUNCTIONS = new Set(["acceptVault", "rejectVault", "confirmDeath"]);

const memoryUsage = new Map();

const addressOrNull = (value) => {
    if (typeof value !== "string" || !ethers.isAddress(value)) return null;
    return ethers.getAddress(value);
};

const boundedCap = (value, fallback) => {
    const n = Number(value);
    if (Number.isInteger(n) && n > 0 && n <= 100000) return n;
    return fallback;
};

const identityDailyCap = (env = process.env) => boundedCap(env.VAULT_LEGACY_RELAY_DAILY_CAP, DEFAULT_IDENTITY_DAILY_CAP);

const ipDailyCap = (env = process.env) => boundedCap(env.VAULT_LEGACY_RELAY_IP_DAILY_CAP, DEFAULT_IP_DAILY_CAP);

const useSharedStore = (env = process.env) => {
    const forced = String(env.VAULT_LEGACY_STATE_STORE || process.env.VAULT_LEGACY_STATE_STORE || "")
        .trim()
        .toLowerCase();
    if (forced === "memory") return false;
    if (forced === "mongo") return true;
    if (process.env.JEST_WORKER_ID) return false;
    return mongoose.connection.readyState === 1;
};

const dayStamp = (nowMs) => new Date(nowMs).toISOString().slice(0, 10);

const provenAddress = (legacyUser) => {
    if (!legacyUser || legacyUser.proof !== "eip191") return null;
    return addressOrNull(legacyUser.ethAddress);
};

const requestIp = (ctx) => {
    if (!ctx || typeof ctx.get !== "function") return "";
    try {
        return clientIp(ctx) || "";
    } catch (_error) {
        return "";
    }
};

const logLegacyRelay = (fnName) => {
    console.warn(
        JSON.stringify({
            event: "vault_legacy_relay_without_wallet_proof",
            fn: fnName,
        })
    );
};

/**
 * Calldata-level decision. Vault-id calls still need `assertVaultRole` after a lookup.
 * @param {{ legacyUser: object, fnName: string, decoded: { args: unknown[] }, env?: NodeJS.ProcessEnv }} input
 */
const assessCall = ({ legacyUser, fnName, decoded, env = process.env }) => {
    const mode = sessionProofMode(env);
    const address = provenAddress(legacyUser);
    const enforce = mode === "required" || legacyUser?.proof === "eip191";

    if (!enforce) return { legacy: true, enforce: false, fnName, needsVault: false };

    if (!address) throw relayError("RELAY_IDENTITY_REQUIRED", 403);

    if (fnName === "createVault") {
        const owner = addressOrNull(String(decoded?.args?.[0] ?? ""));
        if (owner !== address) throw relayError("RELAY_IDENTITY_MISMATCH", 403);
        return { legacy: false, enforce: true, address, fnName, needsVault: false };
    }

    let vaultId = "";
    try {
        vaultId = LegacyDemo.normalizeVaultId(decoded?.args?.[0]);
    } catch (_error) {
        throw relayError("RELAY_CALLDATA_INVALID", 400);
    }
    if (!/^0x[0-9a-f]{64}$/.test(vaultId)) throw relayError("RELAY_CALLDATA_INVALID", 400);

    if (fnName === "executeVault") {
        const beneficiary = addressOrNull(String(decoded?.args?.[1] ?? ""));
        if (beneficiary !== address) throw relayError("RELAY_IDENTITY_MISMATCH", 403);
        return { legacy: false, enforce: true, address, fnName, needsVault: true, vaultId, role: "beneficiary" };
    }

    const role = OWNER_FUNCTIONS.has(fnName) ? "owner" : LAWYER_FUNCTIONS.has(fnName) ? "lawyer" : null;
    if (!role) throw relayError("RELAY_SELECTOR_NOT_ALLOWED", 400);

    return { legacy: false, enforce: true, address, fnName, needsVault: true, vaultId, role };
};

const assertVaultRole = (verdict, vault) => {
    if (!verdict?.needsVault) return;
    if (!vault || vault.exists !== true) throw relayError("RELAY_VAULT_UNVERIFIED", 403);

    if (verdict.role === "owner") {
        if (addressOrNull(vault.owner) !== verdict.address) throw relayError("RELAY_IDENTITY_MISMATCH", 403);
        return;
    }

    if (verdict.role === "lawyer") {
        if (addressOrNull(vault.lawyer) !== verdict.address) throw relayError("RELAY_IDENTITY_MISMATCH", 403);
        return;
    }

    if (verdict.role === "beneficiary") {
        const members = (vault.beneficiaries || []).map((value) => addressOrNull(String(value))).filter(Boolean);
        if (!members.includes(verdict.address)) throw relayError("RELAY_IDENTITY_MISMATCH", 403);
        return;
    }

    throw relayError("RELAY_VAULT_UNVERIFIED", 403);
};

const lookupVault = async (provider, registry, vaultId) => {
    if (!provider || typeof provider.call !== "function") return undefined;
    try {
        const data = iface.encodeFunctionData("getVault", [vaultId]);
        const raw = await provider.call({ to: registry, data });
        const decoded = iface.decodeFunctionResult("getVault", raw);
        const vault = decoded[0];
        return {
            exists: Boolean(vault.exists),
            owner: vault.owner,
            lawyer: vault.lawyer,
            beneficiaries: Array.from(vault.beneficiaries || []),
        };
    } catch (_error) {
        return undefined;
    }
};

const identityUsageKey = (legacyUser, day) => {
    const address = provenAddress(legacyUser);
    if (address) return `relay:addr:${address.toLowerCase()}:${day}`;
    const identifier = String(legacyUser?.identifier || "").trim().toLowerCase();
    return `relay:id:${identifier}:${day}`;
};

const ipUsageKey = (ip, day) => `relay:ip:${String(ip || "").trim() || "missing"}:${day}`;

const incrementMemory = async (key) => {
    const row = memoryUsage.get(key) || { count: 0 };
    row.count += 1;
    memoryUsage.set(key, row);
    return row.count;
};

const incrementMongo = async (key, expiresAt) => {
    const update = () =>
        Usage.findOneAndUpdate(
            { key },
            { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
            { new: true, upsert: true }
        ).lean();

    try {
        const doc = await update();
        return doc?.count;
    } catch (error) {
        if (error && error.code === 11000) {
            const doc = await Usage.findOneAndUpdate({ key }, { $inc: { count: 1 } }, { new: true }).lean();
            return doc?.count;
        }
        throw error;
    }
};

const reserveRelay = async ({ legacyUser, ip, env = process.env, now = Date.now() }) => {
    const clock = now instanceof Date ? now.getTime() : now;
    const day = dayStamp(clock);
    const expiresAt = new Date(clock + USAGE_KEEP_MS);
    const shared = useSharedStore(env);
    const increment = shared ? (key) => incrementMongo(key, expiresAt) : incrementMemory;

    let identityCount;
    let ipCount;
    try {
        identityCount = await increment(identityUsageKey(legacyUser, day));
        ipCount = await increment(ipUsageKey(ip, day));
    } catch (_error) {
        throw relayError("RELAY_USAGE_UNAVAILABLE", 503);
    }

    if (typeof identityCount !== "number" || typeof ipCount !== "number") {
        throw relayError("RELAY_USAGE_UNAVAILABLE", 503);
    }

    if (identityCount > identityDailyCap(env)) throw relayError("RELAY_DAILY_CAP_EXCEEDED", 429);
    if (ipCount > ipDailyCap(env)) throw relayError("RELAY_IP_DAILY_CAP_EXCEEDED", 429);
};

const _resetRelayGuard = () => {
    memoryUsage.clear();
};

module.exports = {
    DEFAULT_IDENTITY_DAILY_CAP,
    DEFAULT_IP_DAILY_CAP,
    assertVaultRole,
    assessCall,
    logLegacyRelay,
    lookupVault,
    requestIp,
    reserveRelay,
    _resetRelayGuard,
};
