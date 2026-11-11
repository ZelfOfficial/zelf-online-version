/**
 * Free plans stay on EVM until they upgrade. Activating a non-EVM chain the name
 * does not already have is refused. Addresses already stored on the Zelf ID stay
 * usable for balances, history, and sending; this module does not gate those reads.
 */
const mongoose = require("mongoose");

const { normalizeZelfName } = require("../../Tags/modules/zelf-name.util");
const { limitsForPlan, planError, resolveEntitlement, upgradePlans } = require("../../ZelfKeys/modules/zelf-key-plan-limits.module");
const Activation = require("../models/zelf-id-chain-activation.model");
const { assertSupportedChain } = require("../../../Core/unsupported-networks");

const EVM_CHAINS = [
    { chain: "ethereum", aliases: ["eth", "evm"] },
    { chain: "polygon", aliases: ["matic", "pol"] },
    { chain: "bsc", aliases: ["bnb", "binance", "binance-smart-chain"] },
    { chain: "avalanche", aliases: ["avax"] },
    { chain: "base", aliases: [] },
    { chain: "optimism", aliases: ["op"] },
    { chain: "arbitrum", aliases: ["arb"] },
    { chain: "fantom", aliases: ["ftm", "sonic"] },
    { chain: "aurora", aliases: [] },
];

const NON_EVM_CHAINS = [
    { chain: "solana", aliases: ["sol"], fields: ["solanaAddress"] },
    { chain: "bitcoin", aliases: ["btc"], fields: ["btcAddress", "bitcoinAddress"] },
    { chain: "sui", aliases: [], fields: ["suiAddress"] },
    { chain: "stellar", aliases: ["xlm"], fields: ["xlmAddress", "stellarAddress"] },
    { chain: "ton", aliases: [], fields: ["tonAddress"] },
    { chain: "aptos", aliases: ["apt"], fields: ["aptosAddress"] },
    { chain: "polkadot", aliases: ["dot"], fields: ["dotAddress", "polkadotAddress"] },
    { chain: "kusama", aliases: ["ksm"], fields: ["ksmAddress", "kusamaAddress"] },
    { chain: "arweave", aliases: ["ar"], fields: ["arweaveAddress"] },
];

const CHAIN_BY_KEY = new Map();
for (const spec of EVM_CHAINS) {
    const row = { ...spec, nonEvm: false, family: "evm", fields: ["ethAddress", "evmAddress"] };
    CHAIN_BY_KEY.set(spec.chain, row);
    for (const alias of spec.aliases) CHAIN_BY_KEY.set(alias, row);
}
for (const spec of NON_EVM_CHAINS) {
    const row = { ...spec, nonEvm: true, family: spec.chain };
    CHAIN_BY_KEY.set(spec.chain, row);
    for (const alias of spec.aliases) CHAIN_BY_KEY.set(alias, row);
}

const chainKey = (value) =>
    String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, "-");

const lookupChain = (value) => CHAIN_BY_KEY.get(chainKey(value)) || null;

const requireChain = (value) => {
    assertSupportedChain(value);
    const spec = lookupChain(value);
    if (!spec) {
        throw planError(409, "ERR_CHAIN_UNKNOWN", "Chain is not supported", { chain: chainKey(value) || value });
    }
    return spec;
};

const fieldValue = (publicData, field) => {
    const value = publicData?.[field];
    return typeof value === "string" && value.trim() ? value.trim() : "";
};

const hasAddress = (publicData, spec) => (spec?.fields || []).some((field) => Boolean(fieldValue(publicData, field)));

const isDuplicateKey = (error) => {
    const code = error?.code ?? error?.cause?.code;
    if (code === 11000) return true;
    const message = `${error?.message || ""} ${error?.cause?.message || ""}`;
    return message.includes("E11000") || message.includes("duplicate key") || /must be unique/i.test(message);
};

let indexesReady = null;
const ensureIndexes = () => {
    if (mongoose.connection.readyState !== 1) return Promise.resolve();
    if (!indexesReady) {
        indexesReady = Activation.createIndexes().catch((error) => {
            indexesReady = null;
            throw error;
        });
    }
    return indexesReady;
};

const loadActivatedChains = async (zelfName) => {
    if (!zelfName) return new Set();
    if (mongoose.connection.readyState !== 1) {
        if (process.env.NODE_ENV === "test") return new Set();
        throw planError(503, "ERR_CHAIN_STORE_UNAVAILABLE", "Chain store is unavailable");
    }
    await ensureIndexes();
    const rows = await Activation.find({ zelfName }).select("chain").lean();
    return new Set(rows.map((row) => row.chain));
};

const nonEvmLimitReached = ({ plan, chain, chains }) =>
    planError(409, "ERR_PLAN_LIMIT_REACHED", "Plan limit reached", {
        kind: "nonEvmChain",
        chain,
        ...(chains ? { chains } : {}),
        count: 0,
        limit: 0,
        plan,
        tokenCost: null,
        extraSlots: 0,
    });

const SYNC_NETWORK_TO_CHAIN = {
    bitcoin: "bitcoin",
    sui: "sui",
    stellar: "stellar",
    kusama: "kusama",
    polkadot: "polkadot",
    ton: "ton",
    aptos: "aptos",
};

/**
 * Remember non-EVM chains a wallet just published from its own seed.
 * Sync and offline lease always save those addresses. A later explicit
 * activation sees the chain as already on the name.
 * A missing store does not fail the sync.
 * @param {Object} params
 * @param {Object} params.publicData
 * @param {string[]} params.networks
 * @returns {Promise<{ recorded: string[] }>}
 */
const recordSyncedNonEvmChains = async ({ publicData, networks }) => {
    const chains = [...new Set((networks || []).map((network) => SYNC_NETWORK_TO_CHAIN[network]).filter(Boolean))];
    if (!chains.length) return { recorded: [] };

    if (mongoose.connection.readyState !== 1) {
        if (process.env.NODE_ENV !== "test") {
            console.error("Chain activation store is unavailable; synced addresses were saved");
        }
        return { recorded: [] };
    }

    const normalized = normalizeZelfName(publicData?.zelfName || publicData?.tagName, publicData?.domain || "zelf");
    if (!normalized.zelfName) return { recorded: [] };

    const identity = {
        zelfName: normalized.zelfName,
        domain: normalized.domain,
        tagName: normalized.tagName,
    };
    const recorded = [];
    for (const chain of chains) {
        try {
            await recordActivation({ identity, chain });
            recorded.push(chain);
        } catch (error) {
            console.error("Synced chain was not recorded:", chain, error?.message || error);
        }
    }
    return { recorded };
};

const presentChain = (spec, { publicData, activated, limits }) => {
    const addressPresent = hasAddress(publicData, spec);
    const recorded = activated.has(spec.chain);
    const active = addressPresent || recorded;
    const row = {
        chain: spec.chain,
        family: spec.family,
        nonEvm: spec.nonEvm,
        addressPresent,
        active,
        allowed: !spec.nonEvm || limits.nonEvmChains || active,
    };
    return row;
};

const chainStatus = async (authUser, options = {}) => {
    const entitlement = await resolveEntitlement(authUser, options);
    const limits = limitsForPlan(entitlement.plan, entitlement.domainConfig);
    const activated = await loadActivatedChains(entitlement.identity.zelfName);
    const specs = [...EVM_CHAINS, ...NON_EVM_CHAINS].map((spec) => CHAIN_BY_KEY.get(spec.chain));

    return {
        zelfName: entitlement.identity.zelfName,
        plan: entitlement.plan,
        nonEvmChains: limits.nonEvmChains,
        upgrade: upgradePlans(entitlement.plan, entitlement.domainConfig).nonEvmChains,
        chains: specs.map((spec) =>
            presentChain(spec, { publicData: entitlement.publicData, activated, limits }),
        ),
    };
};

const recordActivation = async ({ identity, chain, now }) => {
    if (mongoose.connection.readyState !== 1) {
        throw planError(503, "ERR_CHAIN_STORE_UNAVAILABLE", "Chain store is unavailable");
    }
    await ensureIndexes();
    const activatedAt = now ? new Date(now) : new Date();
    try {
        await Activation.create({
            zelfName: identity.zelfName,
            domain: identity.domain,
            tagName: identity.tagName,
            chain,
            activatedAt,
        });
        return { alreadyActive: false };
    } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        return { alreadyActive: true };
    }
};

/**
 * Allow EVM activation, except a first activation of a closed chain.
 * Allow a non-EVM chain when the plan permits it, or when that chain is already
 * on the name or was activated earlier.
 * @param {Object} authUser
 * @param {string} chain
 * @param {Object} [options]
 */
const activateChain = async (authUser, chain, options = {}) => {
    const spec = requireChain(chain);
    const entitlement = await resolveEntitlement(authUser, options);
    const limits = limitsForPlan(entitlement.plan, entitlement.domainConfig);
    const addressPresent = hasAddress(entitlement.publicData, spec);

    if (!spec.nonEvm || addressPresent) {
        return {
            chain: spec.chain,
            family: spec.family,
            nonEvm: spec.nonEvm,
            activated: true,
            alreadyActive: addressPresent,
            plan: entitlement.plan,
            nonEvmChains: limits.nonEvmChains,
        };
    }

    const activated = await loadActivatedChains(entitlement.identity.zelfName);
    if (activated.has(spec.chain)) {
        return {
            chain: spec.chain,
            family: spec.family,
            nonEvm: true,
            activated: true,
            alreadyActive: true,
            plan: entitlement.plan,
            nonEvmChains: limits.nonEvmChains,
        };
    }

    if (!limits.nonEvmChains) {
        throw nonEvmLimitReached({ plan: entitlement.plan, chain: spec.chain });
    }

    const recorded = await recordActivation({
        identity: entitlement.identity,
        chain: spec.chain,
        now: options.now,
    });

    return {
        chain: spec.chain,
        family: spec.family,
        nonEvm: true,
        activated: true,
        alreadyActive: recorded.alreadyActive,
        plan: entitlement.plan,
        nonEvmChains: limits.nonEvmChains,
    };
};

module.exports = {
    EVM_CHAINS,
    NON_EVM_CHAINS,
    activateChain,
    chainStatus,
    ensureIndexes,
    hasAddress,
    lookupChain,
    recordSyncedNonEvmChains,
    requireChain,
};
