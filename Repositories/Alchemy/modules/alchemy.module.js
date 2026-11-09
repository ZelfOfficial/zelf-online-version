const { formatEther, formatUnits, getAddress, isAddress } = require("ethers");

const config = require("../../../Core/config");
const { fetchTransfers, rpcRequest } = require("./alchemy-rpc.util");
const { searchTag } = require("../../Tags/modules/tags-search.module");
const { getDomainConfig } = require("../../Tags/config/supported-domains");
const { getSessionFullTagName } = require("../middlewares/alchemy.middleware");

const ALCHEMY_ALL_TOKENS_SPEC = "erc20";
const NATIVE_SYMBOLS = Object.freeze({
    arbitrum: "ETH",
    avalanche: "AVAX",
    ethereum: "ETH",
    optimism: "ETH",
    polygon: "MATIC",
});

const createError = (status, message) => {
    const error = new Error(`${status}:${message}`);
    error.status = status;
    return error;
};

const normalizeAddress = (value) => {
    if (!value || !isAddress(value)) return null;

    return getAddress(value);
};

const sameAddress = (left, right) => {
    const normalizedLeft = normalizeAddress(left);
    const normalizedRight = normalizeAddress(right);

    if (!normalizedLeft || !normalizedRight) return false;

    return normalizedLeft === normalizedRight;
};

const parseHexBalance = (value) => {
    if (!value) return 0n;

    try {
        return BigInt(value);
    } catch (_) {
        return 0n;
    }
};

const formatTokenBalance = (rawBalance, decimals) => {
    const safeDecimals = Number.isInteger(decimals) && decimals >= 0 ? decimals : 18;

    try {
        return formatUnits(rawBalance, safeDecimals);
    } catch (_) {
        return rawBalance;
    }
};

const getCuratedTokenContracts = (network) => {
    const curatedTokenMap = config.alchemy?.curatedTokens?.[network];

    if (!curatedTokenMap || Object.keys(curatedTokenMap).length === 0) {
        throw createError(409, `curated_token_mode_not_configured_for_${network}`);
    }

    return Object.values(curatedTokenMap);
};

const getTokenBalanceSpec = (network, tokenMode = "all") => {
    if (tokenMode === "curated") {
        return getCuratedTokenContracts(network);
    }

    return ALCHEMY_ALL_TOKENS_SPEC;
};

const resolveOwnedTagAddress = async ({ tagName, domain }, authUser) => {
    const fullTagName = `${tagName}.${domain}`.toLowerCase();
    const sessionTagName = String(authUser?.tagName || "").toLowerCase();
    const sessionFullTagName = getSessionFullTagName(authUser);

    if (!sessionTagName) {
        throw createError(403, "owned_tag_session_required");
    }

    if (sessionFullTagName !== fullTagName) {
        throw createError(403, "tag_not_owned");
    }

    const domainConfig = getDomainConfig(domain);
    const tagData = await searchTag({ tagName, domain, domainConfig }, authUser || {});

    if (!tagData || tagData.available || !tagData.tagObject) {
        throw createError(404, "tag_not_found");
    }

    const evmAddress = normalizeAddress(tagData.tagObject?.publicData?.ethAddress);

    if (!evmAddress) {
        throw createError(409, "tag_missing_evm_address");
    }

    if (authUser?.ethAddress && normalizeAddress(authUser.ethAddress) && !sameAddress(authUser.ethAddress, evmAddress)) {
        throw createError(403, "session_address_mismatch");
    }

    return {
        address: evmAddress,
        fullTagName: `${tagName}.${domain}`,
        tagObject: tagData.tagObject,
    };
};

const fetchTokenMetadata = async (network, contractAddress) => {
    try {
        return await rpcRequest(network, "alchemy_getTokenMetadata", [contractAddress]);
    } catch (_) {
        return null;
    }
};

const getBalancesForNetwork = async (network, address, tokenMode = "all") => {
    const tokenBalanceSpec = getTokenBalanceSpec(network, tokenMode);
    const [nativeBalance, tokenBalancesResult] = await Promise.all([
        rpcRequest(network, "eth_getBalance", [address, "latest"]),
        rpcRequest(network, "alchemy_getTokenBalances", [address, tokenBalanceSpec]),
    ]);

    const nonZeroTokenBalances = (tokenBalancesResult?.tokenBalances || []).filter((token) => parseHexBalance(token.tokenBalance) > 0n);
    const maxMetadataRequests = Number(config.alchemy?.maxTokenMetadataRequests) || 50;

    const metadataResults = await Promise.all(
        nonZeroTokenBalances.slice(0, maxMetadataRequests).map(async (token) => ({
            contractAddress: token.contractAddress,
            metadata: await fetchTokenMetadata(network, token.contractAddress),
        }))
    );

    const metadataByContract = new Map(metadataResults.map((entry) => [String(entry.contractAddress).toLowerCase(), entry.metadata]));

    return {
        address,
        nativeBalance: {
            formatted: formatEther(nativeBalance || "0x0"),
            raw: nativeBalance || "0x0",
            symbol: NATIVE_SYMBOLS[network] || "ETH",
        },
        network,
        tokenMode,
        tokenBalances: nonZeroTokenBalances.map((token) => {
            const metadata = metadataByContract.get(String(token.contractAddress).toLowerCase());
            const rawBalance = token.tokenBalance || "0x0";
            const decimals = metadata?.decimals;

            return {
                balance: formatTokenBalance(rawBalance, decimals),
                contractAddress: token.contractAddress,
                decimals: Number.isInteger(decimals) ? decimals : null,
                logo: metadata?.logo || null,
                name: metadata?.name || null,
                rawBalance,
                symbol: metadata?.symbol || null,
            };
        }),
        totalTokens: nonZeroTokenBalances.length,
    };
};

const normalizeTransfer = (transfer, direction) => ({
    asset: transfer.asset || null,
    blockNum: transfer.blockNum || null,
    category: transfer.category || null,
    direction,
    erc1155Metadata: transfer.erc1155Metadata || null,
    from: transfer.from || null,
    hash: transfer.hash || null,
    logIndex: transfer.logIndex || null,
    metadata: transfer.metadata || null,
    rawContract: transfer.rawContract || null,
    to: transfer.to || null,
    tokenId: transfer.tokenId || null,
    uniqueId: `${direction}:${transfer.hash || "nohash"}:${transfer.logIndex || "nolog"}:${transfer.category || "nocategory"}`,
    value: transfer.value ?? null,
});

const sortTransfersDescending = (left, right) => {
    const leftBlock = parseHexBalance(left.blockNum || "0x0");
    const rightBlock = parseHexBalance(right.blockNum || "0x0");

    if (leftBlock !== rightBlock) {
        return leftBlock > rightBlock ? -1 : 1;
    }

    const leftTime = left.metadata?.blockTimestamp ? Date.parse(left.metadata.blockTimestamp) : 0;
    const rightTime = right.metadata?.blockTimestamp ? Date.parse(right.metadata.blockTimestamp) : 0;

    return rightTime - leftTime;
};

const getBalances = async ({ domain, networks, tagName, tokenMode = "all" }, authUser) => {
    const { address, fullTagName } = await resolveOwnedTagAddress({ tagName, domain }, authUser);
    const balances = await Promise.all(networks.map((network) => getBalancesForNetwork(network, address, tokenMode)));

    return {
        address,
        domain,
        networks: balances,
        tagName: fullTagName,
        tokenMode,
    };
};

const getTransactions = async ({ domain, maxCount, network, pageKey, tagName }, authUser) => {
    const { address, fullTagName } = await resolveOwnedTagAddress({ tagName, domain }, authUser);
    const [incoming, outgoing] = await Promise.all([
        fetchTransfers({ address, direction: "in", maxCount, network, pageKey }),
        fetchTransfers({ address, direction: "out", maxCount, network, pageKey }),
    ]);

    const merged = [...(incoming?.transfers || []).map((item) => normalizeTransfer(item, "in")), ...(outgoing?.transfers || []).map((item) => normalizeTransfer(item, "out"))]
        .sort(sortTransfersDescending);

    return {
        address,
        domain,
        network,
        pageKey: {
            incoming: incoming?.pageKey || null,
            outgoing: outgoing?.pageKey || null,
        },
        tagName: fullTagName,
        transfers: merged,
    };
};

const getTransaction = async ({ domain, network, tagName, transactionHash }, authUser) => {
    const { address, fullTagName } = await resolveOwnedTagAddress({ tagName, domain }, authUser);
    const [transaction, receipt] = await Promise.all([
        rpcRequest(network, "eth_getTransactionByHash", [transactionHash]),
        rpcRequest(network, "eth_getTransactionReceipt", [transactionHash]),
    ]);

    if (!transaction) {
        throw createError(404, "transaction_not_found");
    }

    const belongsToTagAddress = sameAddress(transaction.from, address) || sameAddress(transaction.to, address);

    if (!belongsToTagAddress) {
        throw createError(404, "transaction_not_found_for_tag");
    }

    return {
        address,
        belongsToTagAddress,
        domain,
        network,
        receipt,
        tagName: fullTagName,
        transaction,
        transactionHash,
    };
};

module.exports = {
    fetchTokenMetadata,
    fetchTransfers,
    formatTokenBalance,
    getBalances,
    getBalancesForNetwork,
    getTransaction,
    getTransactions,
    parseHexBalance,
    rpcRequest,
};
