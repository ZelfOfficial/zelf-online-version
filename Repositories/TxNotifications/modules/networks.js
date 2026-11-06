/**
 * Networks the app may register for received-transfer push (Zelf #566).
 *
 * Keys are the exact lowercase keys of the registration contract. `watched`
 * networks have a watcher adapter; `polkadot` and `kusama` are accepted and
 * validated but not watched yet (phase 2).
 */

const EVM_NETWORKS = Object.freeze(["ethereum", "polygon", "bsc", "avalanche", "blockdag"]);

const NETWORKS = Object.freeze({
    ethereum: { displayName: "Ethereum", family: "evm", nativeSymbol: "ETH", nativeDecimals: 18, watched: true },
    polygon: { displayName: "Polygon", family: "evm", nativeSymbol: "POL", nativeDecimals: 18, watched: true },
    bsc: { displayName: "BNB Smart Chain", family: "evm", nativeSymbol: "BNB", nativeDecimals: 18, watched: true },
    avalanche: { displayName: "Avalanche", family: "evm", nativeSymbol: "AVAX", nativeDecimals: 18, watched: true },
    blockdag: { displayName: "BlockDAG", family: "evm", nativeSymbol: "BDAG", nativeDecimals: 18, watched: true },
    solana: { displayName: "Solana", family: "solana", nativeSymbol: "SOL", nativeDecimals: 9, watched: true },
    bitcoin: { displayName: "Bitcoin", family: "bitcoin", nativeSymbol: "BTC", nativeDecimals: 8, watched: true },
    ton: { displayName: "TON", family: "ton", nativeSymbol: "TON", nativeDecimals: 9, watched: true },
    aptos: { displayName: "Aptos", family: "aptos", nativeSymbol: "APT", nativeDecimals: 8, watched: true },
    sui: { displayName: "Sui", family: "sui", nativeSymbol: "SUI", nativeDecimals: 9, watched: true },
    stellar: { displayName: "Stellar", family: "stellar", nativeSymbol: "XLM", nativeDecimals: 7, watched: true },
    polkadot: { displayName: "Polkadot", family: "substrate", nativeSymbol: "DOT", nativeDecimals: 10, watched: false },
    kusama: { displayName: "Kusama", family: "substrate", nativeSymbol: "KSM", nativeDecimals: 12, watched: false },
});

/**
 * Smallest native amount worth a push. Anything below is treated as dust
 * (spam "memo" transfers, address-poisoning pennies) and only marked seen.
 */
const NATIVE_DUST = Object.freeze({
    ethereum: "0.000001",
    polygon: "0.001",
    bsc: "0.00001",
    avalanche: "0.0001",
    blockdag: "0.001",
    solana: "0.00001",
    bitcoin: "0.00000546",
    ton: "0.001",
    aptos: "0.00001",
    sui: "0.0001",
    stellar: "0.001",
});

/** Token transfers below this are treated as dust regardless of the token. */
const TOKEN_DUST = "0.000001";

const SUPPORTED_NETWORKS = Object.freeze(Object.keys(NETWORKS));
const WATCHED_NETWORKS = Object.freeze(SUPPORTED_NETWORKS.filter((key) => NETWORKS[key].watched));

const isSupportedNetwork = (network) => Object.prototype.hasOwnProperty.call(NETWORKS, network);
const isWatchedNetwork = (network) => isSupportedNetwork(network) && NETWORKS[network].watched;
const networkDisplayName = (network) => NETWORKS[network]?.displayName || network;

module.exports = {
    EVM_NETWORKS,
    NATIVE_DUST,
    NETWORKS,
    SUPPORTED_NETWORKS,
    TOKEN_DUST,
    WATCHED_NETWORKS,
    isSupportedNetwork,
    isWatchedNetwork,
    networkDisplayName,
};
