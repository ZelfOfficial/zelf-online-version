const { getCleanInstance } = require("../../../Core/axios");
const config = require("../../../Core/config");

const instance = getCleanInstance(config.alchemy?.timeoutMs || 30000);

const ALCHEMY_TRANSFER_CATEGORIES = Object.freeze(["external", "internal", "erc20", "erc721", "erc1155", "specialnft"]);

const createError = (status, message) => {
    const error = new Error(`${status}:${message}`);
    error.status = status;
    return error;
};

const toHexQuantity = (value) => {
    const parsed = Number(value);
    return `0x${parsed.toString(16)}`;
};

const getNetworkUrl = (network) => {
    const url = config.alchemy?.networks?.[network];

    if (!url) {
        throw createError(409, "unsupported_network");
    }

    return url;
};

const rpcRequest = async (network, method, params = [], options = {}) => {
    const url = getNetworkUrl(network);
    const requestConfig = {};
    const timeout = Number(options.timeout);

    if (Number.isFinite(timeout) && timeout > 0) {
        requestConfig.timeout = timeout;
    }

    try {
        const { data } = await instance.post(
            url,
            {
                id: `${network}-${method}-${Date.now()}`,
                jsonrpc: "2.0",
                method,
                params,
            },
            requestConfig
        );

        if (data?.error) {
            throw createError(500, data.error.message || "alchemy_request_failed");
        }

        return data?.result;
    } catch (error) {
        if (error.status) throw error;
        if (error.response?.data?.error?.message) throw createError(500, error.response.data.error.message);
        if (error.code === "ECONNABORTED") throw createError(504, "alchemy_timeout");

        throw createError(500, error.message || "alchemy_request_failed");
    }
};

const fetchTransfers = async ({ address, direction, maxCount, network, pageKey, category, order, timeout }) => {
    const params = {
        category: Array.isArray(category) && category.length ? category : ALCHEMY_TRANSFER_CATEGORIES,
        excludeZeroValue: false,
        fromBlock: "0x0",
        maxCount: toHexQuantity(maxCount),
        toBlock: "latest",
        withMetadata: true,
    };

    if (order === "asc" || order === "desc") {
        params.order = order;
    }

    if (pageKey) {
        params.pageKey = pageKey;
    }

    if (direction === "in") {
        params.toAddress = address;
    } else {
        params.fromAddress = address;
    }

    return rpcRequest(network, "alchemy_getAssetTransfers", [params], { timeout });
};

module.exports = {
    fetchTransfers,
    rpcRequest,
};
