/**
 * RPC upstreams for the wallet proxy. URLs are read from the environment on
 * each call. This file must not require Core/config.js (config requires it).
 *
 * Paid extension chains have no public fallback: a missing URL fails closed.
 * Public-chain defaults are only for networks the extension already calls
 * without a provider credential (Arbitrum, Optimism, Base, BlockDAG).
 */

const envUrl = (...keys) => {
    for (const key of keys) {
        const value = String(process.env[key] || "").trim();
        if (value) return value;
    }
    return "";
};

const chainIdFrom = (envKey, fallback) => {
    const n = Number(process.env[envKey]);
    return Number.isFinite(n) && n !== 0 ? n : fallback;
};

const EVM_METHODS = [
    "eth_blockNumber",
    "eth_call",
    "eth_chainId",
    "eth_estimateGas",
    "eth_feeHistory",
    "eth_gasPrice",
    "eth_getBalance",
    "eth_getBlockByHash",
    "eth_getBlockByNumber",
    "eth_getCode",
    "eth_getStorageAt",
    "eth_getTransactionByHash",
    "eth_getTransactionCount",
    "eth_getTransactionReceipt",
    "eth_maxPriorityFeePerGas",
    "net_version",
    "web3_clientVersion",
    "eth_sendRawTransaction",
];

const SOLANA_METHODS = [
    "getAccountInfo",
    "getBalance",
    "getBlock",
    "getBlockHeight",
    "getBlockProduction",
    "getBlocks",
    "getBlocksWithLimit",
    "getEpochInfo",
    "getFeeForMessage",
    "getFirstAvailableBlock",
    "getGenesisHash",
    "getHealth",
    "getLatestBlockhash",
    "getMinimumBalanceForRentExemption",
    "getMultipleAccounts",
    "getRecentPrioritizationFees",
    "getSignaturesForAddress",
    "getSignatureStatuses",
    "getSlot",
    "getTokenAccountBalance",
    "getTokenAccountsByOwner",
    "getTransaction",
    "getVersion",
    "isBlockhashValid",
    "sendTransaction",
    "simulateTransaction",
];

const SUI_METHODS = [
    "sui_getChainIdentifier",
    "sui_getObject",
    "sui_multiGetObjects",
    "sui_getNormalizedMoveModule",
    "sui_getNormalizedMoveModulesByPackage",
    "sui_getNormalizedMoveFunction",
    "sui_getNormalizedMoveStruct",
    "sui_getCoinMetadata",
    "sui_getTotalSupply",
    "sui_getMoveFunctionArgTypes",
    "sui_getProtocolConfig",
    "sui_getLoadedChildObjects",
    "sui_tryGetPastObject",
    "sui_getDynamicFieldObject",
    "sui_getDynamicFields",
    "sui_getTransactionBlock",
    "sui_multiGetTransactionBlocks",
    "sui_getCheckpoint",
    "sui_getCheckpoints",
    "sui_getLatestCheckpointSequenceNumber",
    "sui_getEvents",
    "sui_getLatestSuiSystemState",
    "sui_getReferenceGasPrice",
    "suix_getStakes",
    "suix_getValidatorsApy",
    "suix_getCommitteeInfo",
    "sui_queryTransactionBlocks",
    "sui_queryEvents",
    "sui_queryObjects",
    "sui_resolveNameServiceNames",
    "sui_resolveNameServiceAddress",
    "sui_getAllBalances",
    "sui_getBalance",
    "suix_getAllBalances",
    "suix_getBalance",
    "suix_getCoinMetadata",
    "suix_getReferenceGasPrice",
    "suix_queryTransactionBlocks",
    "sui_getCoins",
    "sui_getAllCoins",
    "dryRunTransactionBlock",
    "executeTransactionBlock",
    "devInspectTransactionBlock",
];

const DEFAULT_ALLOWED_METHODS = [...EVM_METHODS, ...SOLANA_METHODS, ...SUI_METHODS];

const METHODS_BY_KIND = {
    evm: EVM_METHODS,
    solana: SOLANA_METHODS,
    sui: SUI_METHODS,
};

/**
 * @type {Array<{key: string, chainId: () => number, kind: string, paid: () => string, publicUrl?: string, extensionRequiresEnv?: boolean, legacy?: boolean, extension?: boolean}>}
 */
const CHAIN_SPECS = [
    {
        key: "ethereum",
        chainId: () => chainIdFrom("ETHEREUM_CHAIN_ID", 1),
        kind: "evm",
        paid: () => envUrl("EXTENSION_ETHEREUM_RPC_URL", "RPC_PROXY_ETHEREUM_URL", "ETH_MAINNET_RPC_URL", "ETHEREUM_RPC_URL"),
        publicUrl: "https://eth.llamarpc.com",
        extensionRequiresEnv: true,
        legacy: true,
        extension: true,
    },
    {
        key: "ethereum-sepolia",
        chainId: () => chainIdFrom("ETHEREUM_SEPOLIA_CHAIN_ID", 11155111),
        kind: "evm",
        paid: () => envUrl("EXTENSION_ETHEREUM_SEPOLIA_RPC_URL", "ETH_SEPOLIA_RPC_URL", "RPC_PROXY_ETHEREUM_SEPOLIA_URL"),
        extensionRequiresEnv: true,
        legacy: true,
        extension: true,
    },
    {
        key: "polygon",
        chainId: () => chainIdFrom("POLYGON_CHAIN_ID", 137),
        kind: "evm",
        paid: () => envUrl("EXTENSION_POLYGON_RPC_URL", "RPC_PROXY_POLYGON_URL", "POLYGON_RPC_URL"),
        publicUrl: "https://polygon-rpc.com",
        extensionRequiresEnv: true,
        legacy: true,
        extension: true,
    },
    {
        key: "avalanche",
        chainId: () => chainIdFrom("AVALANCHE_CHAIN_ID", 43114),
        kind: "evm",
        paid: () => envUrl("EXTENSION_AVALANCHE_RPC_URL", "RPC_PROXY_AVALANCHE_URL", "AVALANCHE_RPC_URL"),
        publicUrl: "https://api.avax.network/ext/bc/C/rpc",
        extensionRequiresEnv: true,
        legacy: true,
        extension: true,
    },
    {
        key: "bsc",
        chainId: () => chainIdFrom("BSC_CHAIN_ID", 56),
        kind: "evm",
        paid: () => envUrl("EXTENSION_BSC_RPC_URL", "RPC_PROXY_BSC_URL", "BSC_RPC_URL"),
        publicUrl: "https://bsc-dataseed.binance.org",
        extensionRequiresEnv: true,
        legacy: true,
        extension: true,
    },
    {
        key: "arbitrum",
        chainId: () => chainIdFrom("ARBITRUM_CHAIN_ID", 42161),
        kind: "evm",
        paid: () => envUrl("EXTENSION_ARBITRUM_RPC_URL", "RPC_PROXY_ARBITRUM_URL", "ARBITRUM_RPC_URL"),
        publicUrl: "https://arb1.arbitrum.io/rpc",
        legacy: true,
        extension: true,
    },
    {
        key: "optimism",
        chainId: () => chainIdFrom("OPTIMISM_CHAIN_ID", 10),
        kind: "evm",
        paid: () => envUrl("EXTENSION_OPTIMISM_RPC_URL", "RPC_PROXY_OPTIMISM_URL", "OPTIMISM_RPC_URL"),
        publicUrl: "https://mainnet.optimism.io",
        legacy: true,
        extension: true,
    },
    {
        key: "base",
        chainId: () => chainIdFrom("BASE_CHAIN_ID", 8453),
        kind: "evm",
        paid: () => envUrl("EXTENSION_BASE_RPC_URL", "RPC_PROXY_BASE_URL", "BASE_RPC_URL"),
        publicUrl: "https://mainnet.base.org",
        legacy: true,
        extension: true,
    },
    {
        key: "blockdag",
        chainId: () => chainIdFrom("BLOCKDAG_CHAIN_ID", 1404),
        kind: "evm",
        paid: () =>
            envUrl("EXTENSION_BLOCKDAG_RPC_URL", "RPC_PROXY_BLOCKDAG_URL", "BLOCKDAG_MAIN_RPC_URL", "BLOCKDAG_RPC_URL"),
        publicUrl: "https://rpc.east.bdag-us.org",
        legacy: true,
        extension: true,
    },
    {
        key: "solana",
        chainId: () => chainIdFrom("SOLANA_PROXY_CHAIN_ID", 102),
        kind: "solana",
        paid: () => envUrl("EXTENSION_SOLANA_RPC_URL", "SOLANA_RPC_URL", "SOLANA_RPC_ENDPOINT"),
        extensionRequiresEnv: true,
        extension: true,
    },
    {
        key: "sui",
        chainId: () => chainIdFrom("SUI_CHAIN_ID", 101),
        kind: "sui",
        paid: () => envUrl("RPC_PROXY_SUI_URL", "SUI_RPC_URL"),
        publicUrl: "https://fullnode.mainnet.sui.io:443",
        legacy: true,
    },
];

const materialize = (spec, { extension }) => {
    const paid = spec.paid();
    const allowPublic = !(extension && spec.extensionRequiresEnv);
    const rpcUrl = paid || (allowPublic ? spec.publicUrl || "" : "");
    return {
        chainId: spec.chainId(),
        rpcUrl,
        kind: spec.kind,
        requireUpstream: Boolean(extension && spec.extensionRequiresEnv),
    };
};

const chainsFrom = ({ extension }) => {
    const out = {};
    for (const spec of CHAIN_SPECS) {
        if (extension && !spec.extension) continue;
        if (!extension && !spec.legacy) continue;
        out[spec.key] = materialize(spec, { extension });
    }
    return out;
};

const extensionChains = () => chainsFrom({ extension: true });
const legacyChains = () => chainsFrom({ extension: false });

const bitcoinUpstream = (network) => {
    if (network === "mainnet") return envUrl("EXTENSION_BTC_MAINNET_RPC_URL", "BTC_MAINNET_BLOCKBOOK_URL");
    if (network === "testnet") return envUrl("EXTENSION_BTC_TESTNET_RPC_URL", "BTC_TESTNET_BLOCKBOOK_URL");
    return "";
};

const stellarUpstream = () => envUrl("EXTENSION_STELLAR_HORIZON_URL");

const methodsForKind = (kind) => METHODS_BY_KIND[kind] || [];

/** Largest upstream body the proxy will buffer. */
const UPSTREAM_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

const isUpstreamResponseTooLarge = (error) => String(error?.message || "").startsWith("maxContentLength size of ");

const maxBodyBytes = () => {
    const n = Number(process.env.RPC_PROXY_MAX_BODY_BYTES);
    return Number.isFinite(n) && n >= 1024 ? Math.min(n, 1024 * 1024) : 262144;
};

const maxBatch = () => {
    const n = Number(process.env.RPC_PROXY_MAX_BATCH);
    return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 20) : 10;
};

/** Strip provider URLs and path tokens before anything is logged or returned. */
const redactSecrets = (value) => {
    const text = String(value ?? "");
    return text
        .replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted-url]")
        .replace(/\b[a-z0-9-]+\.(?:quiknode|quicknode)\.pro\b/gi, "[redacted-host]")
        .slice(0, 300);
};

const upstreamSecretParts = (upstreamUrl) => {
    if (!upstreamUrl) return null;
    try {
        const url = new URL(upstreamUrl);
        const pathname = url.pathname.replace(/\/+$/, "");
        return {
            origin: url.origin,
            host: url.host,
            base: `${url.origin}${pathname}`,
            token:
                pathname
                    .split("/")
                    .filter(Boolean)
                    .find((part) => part.length >= 16 && /^[A-Za-z0-9]+$/.test(part)) || "",
        };
    } catch {
        return null;
    }
};

const bodyContainsUpstreamSecret = (body, upstreamUrl) => {
    const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
    if (/quiknode|quicknode/i.test(text)) return true;
    const parts = upstreamSecretParts(upstreamUrl);
    if (!parts) return false;
    if (parts.host && text.includes(parts.host)) return true;
    if (parts.token && text.includes(parts.token)) return true;
    return false;
};

/**
 * Horizon HAL `_links` use absolute hrefs on the upstream host. Rewrite those
 * to relative paths so the payload can be returned. Any host or token that
 * remains outside those links is still treated as a leak.
 */
const rewriteHref = (href, parts) => {
    if (typeof href !== "string" || !parts?.base) return href;
    if (!href.includes(parts.base) && !(parts.origin && href.startsWith(parts.origin))) return href;
    let rewritten = href.split(parts.base).join("");
    if (parts.origin && rewritten.startsWith(parts.origin)) {
        rewritten = rewritten.slice(parts.origin.length);
    }
    if (parts.token) {
        rewritten = rewritten.replace(new RegExp(`/${parts.token}(?=/|\\?|$)`), "");
    }
    if (rewritten === "" || rewritten.startsWith("?")) return `/${rewritten}`;
    return rewritten;
};

const rewriteLinkObject = (link, parts) => {
    if (!link || typeof link !== "object" || Array.isArray(link)) return link;
    if (typeof link.href !== "string") return link;
    return { ...link, href: rewriteHref(link.href, parts) };
};

const rewriteHorizonLinks = (node, parts) => {
    if (Array.isArray(node)) return node.map((item) => rewriteHorizonLinks(item, parts));
    if (!node || typeof node !== "object") return node;
    const out = {};
    for (const [key, value] of Object.entries(node)) {
        if (key === "_links" && value && typeof value === "object" && !Array.isArray(value)) {
            const links = {};
            for (const [rel, link] of Object.entries(value)) {
                links[rel] = rewriteLinkObject(link, parts);
            }
            out[key] = links;
        } else {
            out[key] = rewriteHorizonLinks(value, parts);
        }
    }
    return out;
};

const sanitizeUpstreamBody = (body, upstreamUrl) => {
    const parts = upstreamSecretParts(upstreamUrl);
    const rewritten = parts && body && typeof body === "object" ? rewriteHorizonLinks(body, parts) : body;
    if (bodyContainsUpstreamSecret(rewritten, upstreamUrl)) {
        return { leaked: true, body: null };
    }
    return { leaked: false, body: rewritten };
};

module.exports = {
    CHAIN_SPECS,
    DEFAULT_ALLOWED_METHODS,
    EVM_METHODS,
    SOLANA_METHODS,
    SUI_METHODS,
    bitcoinUpstream,
    bodyContainsUpstreamSecret,
    sanitizeUpstreamBody,
    extensionChains,
    legacyChains,
    UPSTREAM_RESPONSE_MAX_BYTES,
    isUpstreamResponseTooLarge,
    maxBatch,
    maxBodyBytes,
    methodsForKind,
    redactSecrets,
    stellarUpstream,
};
