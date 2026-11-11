const config = require("../../../Core/config");
const aptos = require("./aptos.adapter");
const bitcoin = require("./bitcoin.adapter");
const solana = require("./solana.adapter");
const stellar = require("./stellar.adapter");
const sui = require("./sui.adapter");
const ton = require("./ton.adapter");
const { createEvmAlchemyAdapter, isAlchemyConfigured } = require("./evm-alchemy.adapter");
const { createEvmRpcAdapter } = require("./evm-rpc.adapter");

/**
 * Network → adapter. Every adapter exposes
 *   poll({ address, state, seen, minTimestampMs, now }) → { state, transfers, observed }
 * where `transfers` are normalized incoming transfers
 *   { network, hash, amount (decimal string | null), asset, from, timestampMs, native, seenId? }
 * already filtered to "received by this account, not sent by it, curated asset",
 * and `observed` lists every id the watcher should remember as seen.
 */

/** Alchemy refusing the method or the key means it will keep refusing: switch to plain RPC. */
const isPermanentAlchemyFailure = (error) => /_rpc_-326(00|01|02)$|_http_(400|401|403|404)$/.test(String(error?.code || ""));

const withRpcFallback = (network) => {
    const primary = createEvmAlchemyAdapter(network);
    const fallback = createEvmRpcAdapter(network);
    let usePrimary = true;

    return {
        network,
        source: () => (usePrimary ? "alchemy" : "rpc"),
        poll: async (args) => {
            if (usePrimary) {
                try {
                    return await primary.poll(args);
                } catch (error) {
                    if (!isPermanentAlchemyFailure(error)) throw error;
                    usePrimary = false;
                    console.warn(`[tx-watcher] ${network}: Alchemy unavailable (${error.code}); using JSON-RPC`);
                }
            }
            return fallback.poll(args);
        },
    };
};

const evmAdapter = (network) => (isAlchemyConfigured(network) ? withRpcFallback(network) : createEvmRpcAdapter(network));

let registry = null;

const buildRegistry = () => ({
    ethereum: evmAdapter("ethereum"),
    polygon: evmAdapter("polygon"),
    avalanche: evmAdapter("avalanche"),
    bsc: createEvmRpcAdapter("bsc"),
    solana,
    bitcoin,
    ton,
    aptos,
    sui,
    stellar,
});

const getAdapter = (network) => {
    if (!registry) registry = buildRegistry();
    return registry[network] || null;
};

/** How many accounts of one network are polled at the same time (provider rate limits). */
const concurrencyFor = (network) => {
    const limits = {
        solana: 4,
        ethereum: 3,
        polygon: 3,
        avalanche: 3,
        bsc: 3,
        bitcoin: 2,
        ton: config.ton?.apiKey ? 3 : 1,
        aptos: 3,
        sui: 3,
        stellar: 3,
    };
    return limits[network] || 2;
};

module.exports = {
    concurrencyFor,
    getAdapter,
    isPermanentAlchemyFailure,
};
