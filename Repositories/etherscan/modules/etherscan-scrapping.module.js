require("dotenv").config();
const urlBase = process.env.MICROSERVICES_BOGOTA_URL;
const token = process.env.MICROSERVICES_BOGOTA_TOKEN;
const axios = require("axios");
const moment = require("moment");
const https = require("https");

const config = require("../../../Core/config");
const { mapGasOracleToTrackerShape, weiHexToGwei, weiHexToEth, gasTrackerFromNetworkGwei } = require("./etherscan-gas-tracker.util");
const { getCleanInstance } = require("../../../Core/axios");
const {
    buildNativeEthHoldingRow,
    getEthereumPortfolioViaAlchemy,
    getEthereumPortfolioViaEthplorer,
    isAlchemyEthereumConfigured,
    sumFiatBalance,
} = require("./ethereum-address-holdings.util");
const {
    getNaasNodeUrl,
    NAAS_CHAIN,
    refreshNaasCatalogAfterUnauthorized,
    isNaasNodeUnauthorizedError,
} = require("../../../Core/naas-gateway-catalog");
const { getTickerPrice } = require("../../binance/modules/binance.module");
const { get_ApiKey } = require("../../Solana/modules/oklink");
const {
    normalizeTransactionLimit,
    normalizePage,
    mapEtherscanV2Transaction,
    mapRouteScanTransaction,
    buildListResponse,
    fetchTransactionsFromEtherscanV2,
    fetchTransactionsFromRouteScan,
    runTransactionProviderLadder,
    withTxListDeadline,
    DEFAULT_TX_TIMEOUT_MS,
    TX_LIST_DEADLINE_MS,
    ETH_ADDRESS_OVERVIEW_TX_CAP_MS,
    formatUtcIsoDate,
} = require("./evm-transaction-list.util");
const ETH_MAINNET_CHAIN_ID = 1;

const instance = getCleanInstance(1000);
const agent = new https.Agent({ rejectUnauthorized: false });

/** Etherscan API V2 (V1 /api deprecated as of Aug 2025) */
const ETHERSCAN_V2_API = process.env.ETHERSCAN_V2_API || "https://api.etherscan.io/v2/api";

const CHAIN_ID_BY_ENV = {
    bogota: 1,
    production: 1,
    development: 11155111, // Sepolia
};

const etherscanKeyForGas = () => String(process.env.ETHERSCAN_API_KEY || "").trim();

const infuraProjectId = () => process.env.INFURA_APIKEY || config.etherscan.apiKey;

const getGasTrackerFromRpc = async (isSepolia) => {
    const pid = infuraProjectId();
    const rpcUrl = isSepolia
        ? process.env.ETH_SEPOLIA_RPC_URL || null
        : process.env.ETH_MAINNET_RPC_URL || null;

    if (!rpcUrl) {
        throw new Error("gas_tracker_rpc_unconfigured");
    }

    const { data } = await axios.post(
        rpcUrl,
        { jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] },
        { headers: { "Content-Type": "application/json" }, timeout: 30000 }
    );

    if (data.error) throw new Error(data.error.message || "eth_gasPrice_failed");

    const gwei = weiHexToGwei(data.result);
    return gasTrackerFromNetworkGwei(gwei);
};

const environment = "production";

/**
 * Shape Ethplorer-like payload from JSON-RPC eth_getBalance (no ERC-20 list).
 * @param {string} address
 * @returns {Promise<{ ETH: { balance: number }, tokens: [] }>}
 */
const fetchAddressInfoViaEthRpc = async (address, didRefresh401 = false) => {
    const pid = infuraProjectId();
    const ethMainnet = process.env.ETH_MAINNET_RPC_URL || null;
    let catalogEthRpc = null;
    try {
        catalogEthRpc = await getNaasNodeUrl(NAAS_CHAIN.ETHEREUM);
    } catch {
        catalogEthRpc = null;
    }
    const rpcUrl =
        ethMainnet ||
        catalogEthRpc ||
        (pid ? `https://mainnet.infura.io/v3/${pid}` : null);

    if (!rpcUrl) {
        throw new Error("ethplorer_fallback_rpc_unconfigured");
    }

    const usedNaasCatalogFallback = Boolean(!ethMainnet && catalogEthRpc && rpcUrl === catalogEthRpc);

    try {
        const { data } = await instance.post(
            rpcUrl,
            { id: 0, method: "eth_getBalance", params: [address, "latest"], jsonrpc: "2.0" },
            { headers: { "Content-Type": "application/json" } }
        );

        if (data.error) {
            throw new Error(data.error.message || "eth_getBalance_failed");
        }

        return { ETH: { balance: weiHexToEth(data.result) }, tokens: [] };
    } catch (err) {
        if (
            !didRefresh401 &&
            usedNaasCatalogFallback &&
            isNaasNodeUnauthorizedError(err)
        ) {
            await refreshNaasCatalogAfterUnauthorized();
            return fetchAddressInfoViaEthRpc(address, true);
        }
        throw err;
    }
};

/**
 * @param {*} params
 */
const getAddress = async (params) => {
    try {
        const address = params.address;
        const { price } = await getTickerPrice({ symbol: "ETH" });

        const txListPromise = withTxListDeadline(
            getTransactionsList({
                address,
                page: "1",
                show: "10",
                deadlineMs: ETH_ADDRESS_OVERVIEW_TX_CAP_MS,
            }),
            ETH_ADDRESS_OVERVIEW_TX_CAP_MS
        );

        let nativeEthBalance;
        let erc20Tokens = [];
        let totalErc20Count = 0;

        if (isAlchemyEthereumConfigured()) {
            try {
                const portfolio = await getEthereumPortfolioViaAlchemy(address);
                nativeEthBalance = portfolio.nativeEthBalance;
                erc20Tokens = portfolio.tokens;
                totalErc20Count = portfolio.totalTokenCount;
            } catch (alchemyError) {
                console.error({ alchemyPortfolioError: alchemyError.message || alchemyError });
            }
        }

        if (nativeEthBalance === undefined) {
            try {
                const portfolio = await getEthereumPortfolioViaEthplorer(address);
                nativeEthBalance = portfolio.nativeEthBalance;
                erc20Tokens = portfolio.tokens;
                totalErc20Count = portfolio.totalTokenCount;
            } catch (ethplorerError) {
                console.error({ ethplorerPortfolioError: ethplorerError.message || ethplorerError });
                const rpcFallback = await fetchAddressInfoViaEthRpc(address);
                nativeEthBalance = rpcFallback.ETH.balance;
                erc20Tokens = [];
                totalErc20Count = 0;
            }
        }

        const tokens = [...erc20Tokens, buildNativeEthHoldingRow(nativeEthBalance, price)];
        const txListResult = await txListPromise;
        const transactions = txListResult?.transactions || [];

        const fiatBalance = nativeEthBalance * price;
        const response = {
            address,
            balance: nativeEthBalance,
            fiatBalance,
            type: "system_account",
            account: {
                asset: "ETH",
                fiatBalance: fiatBalance.toString(),
                price,
            },
            tokenHoldings: {
                total: totalErc20Count + 1,
                balance: sumFiatBalance(tokens).toString(),
                tokens,
            },
            transactions,
        };

        return response;
    } catch (error) {
        console.error({ error });
    }
};

const getGasTracker = async (params) => {
    const env = params?.env || environment;
    const chainId = CHAIN_ID_BY_ENV[env] ?? CHAIN_ID_BY_ENV.production;
    const apiKey = etherscanKeyForGas();
    const isSepolia = env === "development";

    try {
        const { data } = await instance.get(ETHERSCAN_V2_API, {
            params: {
                chainid: chainId,
                module: "gastracker",
                action: "gasoracle",
                apikey: apiKey,
            },
        });

        if (String(data.status) === "1" && data.result) {
            const mapped = mapGasOracleToTrackerShape(data.result);
            if (mapped) return mapped;
        }
    } catch (error) {
        console.error({ error: error.message || error });
    }

    try {
        return await getGasTrackerFromRpc(isSepolia);
    } catch (rpcError) {
        console.error({ error: rpcError.message || rpcError });
        throw new Error("gas_tracker_unavailable");
    }
};

/**
 * get transaction status
 * @param {Object} params
 */
const getTransactionStatus = async (params) => {
    try {
        const id = params.id;

        const { data } = await instance.get(`${urlBase}/api/evm-tx/ethereum-transaction?address=${id}`, {
            headers: {
                Authorization: `Bearer ${token}`,
            },
        });

        return data;
    } catch (exception) {
        const error = new Error("transaction_not_found");

        error.status = 404;

        throw error;
    }
};

/**
 * get transactions list
 * @param {Object} params
 * @returns
 */
const getEthereumTransactionsFromOkLink = async (address, page, show, price, timeout = DEFAULT_TX_TIMEOUT_MS) => {
    try {
        const t = Date.now();
        const url = `https://www.oklink.com/api/explorer/v2/eth/addresses/${address}/transactionsByClassfy/condition?offset=${page}&limit=${show}&address=${address}&nonzeroValue=false&t=${t}`;

        const { data } = await axios.get(url, {
            httpsAgent: agent,
            timeout,
            validateStatus: (status) => status < 500,
            headers: {
                "X-Apikey": get_ApiKey().getApiKey(),
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
            },
        });

        if (!(data?.code === "0" || data?.code === 0) || !Array.isArray(data?.data?.hits) || data.data.hits.length === 0) {
            return null;
        }

        const transactions = data.data.hits.map((tx) => {
            const value = parseFloat(tx.value || 0);
            const traffic = String(tx.from || "").toLowerCase() === String(address).toLowerCase() ? "OUT" : "IN";

            const ts = Number(tx.blocktime) || 0;

            return {
                hash: tx.hash,
                block: String(tx.blockHeight || ""),
                from: tx.from,
                to: tx.to,
                amount: String(value),
                value: String(value),
                price: Number(price || 0),
                assetPrice: Number(price || 0),
                fiatAmount: (value * Number(price || 0)).toFixed(2),
                traffic,
                method: tx.method || "ETH transfer",
                txnFee: tx.fee ? String(Number(tx.fee)) : "0",
                timestamp: ts,
                blocktime: ts,
                age: ts ? moment(ts * 1000).fromNow() : "",
                date: formatUtcIsoDate(ts),
                asset: "ETH",
            };
        });

        return buildListResponse(transactions, {
            page,
            show,
            total: data.data.total ?? transactions.length,
        });
    } catch (error) {
        console.error({ oklinkEthereumTxError: error?.message || error });
        return null;
    }
};

const getTransactionsList = async (params) => {
    const address = params.address;
    const show = normalizeTransactionLimit(params.show, 10);
    const page = normalizePage(params.page || 1);
    const deadlineMs = params.deadlineMs || TX_LIST_DEADLINE_MS;
    const routeScanNext = params.routeScanNext || params.nextCursor;

    let price = 0;
    try {
        const ticker = await getTickerPrice({ symbol: "ETH" });
        price = Number(ticker?.price || 0);
    } catch (_) {}

    const httpGet = (url, options) => instance.get(url, options);

    const ladderResult = await runTransactionProviderLadder(
        [
            async (hopTimeout, walkDeadlineMs) => {
                const routeScanPage = await fetchTransactionsFromRouteScan(httpGet, {
                    chainId: ETH_MAINNET_CHAIN_ID,
                    address,
                    limit: show,
                    page,
                    nextToken: routeScanNext,
                    timeout: hopTimeout,
                    deadlineMs: walkDeadlineMs ?? hopTimeout,
                });

                if (routeScanPage.incomplete) {
                    return {
                        ...buildListResponse([], {
                            page,
                            show,
                            incomplete: true,
                            hasMore: routeScanPage.hasMore,
                            pagingNote: routeScanPage.pagingNote,
                        }),
                        source: "routescan",
                    };
                }

                const transactions = routeScanPage.items.map((tx) =>
                    mapRouteScanTransaction(tx, address, { asset: "ETH", price })
                );

                return {
                    ...buildListResponse(transactions, {
                        page,
                        show,
                        nextCursor: routeScanPage.nextToken,
                    }),
                    source: "routescan",
                };
            },
            async (timeout) => {
                const etherscanItems = await fetchTransactionsFromEtherscanV2(httpGet, {
                    chainId: ETH_MAINNET_CHAIN_ID,
                    address,
                    page,
                    offset: show,
                    timeout,
                });
                const transactions = etherscanItems.map((tx) =>
                    mapEtherscanV2Transaction(tx, address, { asset: "ETH", price })
                );

                return { ...buildListResponse(transactions, { page, show }), source: "etherscan_v2" };
            },
            async (timeout) => {
                const oklinkResponse = await getEthereumTransactionsFromOkLink(address, page - 1, show, price, timeout);
                if (!oklinkResponse?.transactions?.length) return null;
                return { ...oklinkResponse, source: "oklink" };
            },
            async (timeout) => {
                const bogotaUrl = process.env.MICROSERVICES_BOGOTA_URL || urlBase;
                const bogotaToken = process.env.MICROSERVICES_BOGOTA_TOKEN || token;
                if (!bogotaUrl || !bogotaToken) return null;

                const { data } = await instance.get(
                    `${bogotaUrl}/api/evm-tx/ethereum-transactions?address=${address}&show=${show}`,
                    {
                        headers: { Authorization: `Bearer ${bogotaToken}` },
                        timeout,
                    }
                );

                if (!Array.isArray(data) || data.length === 0) return null;

                return {
                    pagination: { records: String(data.length), pages: "1", page: String(page) },
                    transactions: data,
                    source: "bogota",
                };
            },
        ],
        { deadlineMs }
    );

    if (ladderResult) return ladderResult;

    return {
        pagination: { records: "0", pages: "0", page: String(page) },
        transactions: [],
    };
};

/**
 * get transaction status v2
 * @param {Object} params
 */
const getTransactionStatusV2 = async (params) => {
    let transaction = null;

    try {
        const t = Date.now();

        const { id } = params;

        const url = `https://www.oklink.com/api/explorer/v1/eth/transactions/${id}?t=${t}`;

        const { data } = await axios.get(url, {
            httpsAgent: agent,
            headers: {
                "X-Apikey": get_ApiKey().getApiKey(),
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
            },
        });

        const details = data?.data;

        if (!details) return null;

        const type = details.inputHex === "0x" ? "transfer" : "swap";

        transaction = {
            age: moment(details.blocktime * 1000).fromNow(),
            amount: details.value.toString(),
            assetPrice: details.legalRate.toString(),
            block: details.blockHeigh,
            confirmations: details.confirm,
            date: moment(details.blocktime * 1000).format("YYYY-MM-DD HH:mm:ss"),
            from: details.from,
            gasPrice: details.gasPrice.toString(),
            hash: id,
            image: details.logoUrl,
            status: details.status === "0x1" ? "Success" : "fail",
            to: details.to,
            txnFee: details.fee.toString(),
            type,
        };

        if (type === "swap") {
            const transfersUrl = `https://www.oklink.com/api/explorer/v1/eth/transfers?limit=9999&offset=0&tokenType=ERC20&tranHash=${id}&t=${t}`;

            const response = await axios.get(transfersUrl, {
                httpsAgent: agent,
                headers: {
                    "X-Apikey": get_ApiKey().getApiKey(),
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
                },
            });

            if (!response.data?.data?.hits) return transaction;

            for (let index = response.data.data.hits.length - 1; index >= 0; index--) {
                const hit = response.data.data.hits[index];

                if (hit.from !== details.to || hit.to !== details.from) continue;

                transaction.swapAmount = hit.valueRaw;
                transaction.swapSymbol = hit.symbol;
                transaction.swapLogo = hit.logoUrl;
                transaction.swapContractAddress = hit.tokenContractAddress;

                break;
            }
        }

        return transaction;
    } catch (error) {
        console.error({ error });
    }

    return transaction;
};

module.exports = {
    getAddress,
    getGasTracker,
    getTransactionsList,
    getTransactionStatus,
    getTransactionStatusV2,
};
