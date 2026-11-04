const axios = require("axios");
const moment = require("moment");
const https = require("https");
const { getTickerPrice } = require("../../binance/modules/binance.module");
const config = require("../../../Core/config");

// Create axios instance with timeout and better error handling
const agent = new https.Agent({
    rejectUnauthorized: false,
});

const instance = axios.create({
    // Explorer API is flaky behind Cloudflare; allow a bit more headroom than the old 10s.
    timeout: 15000,
    httpsAgent: agent,
});

// Generate random user agent
const generateRandomUserAgent = () => {
    const userAgents = [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    ];
    return userAgents[Math.floor(Math.random() * userAgents.length)];
};

/** Headers that match browser calls from bdagscan.com (CORS Origin is ignored server-side; CF often prefers them). */
const explorerApiHeaders = () => ({
    "Content-Type": "application/json",
    Accept: "application/json",
    Origin: "https://bdagscan.com",
    Referer: "https://bdagscan.com/",
    "User-Agent": generateRandomUserAgent(),
});

const isRetryableExplorerError = (error) => {
    const code = error?.code;
    if (code === "ECONNABORTED" || code === "ETIMEDOUT" || code === "ECONNRESET" || code === "EAI_AGAIN") {
        return true;
    }
    const status = error?.response?.status;
    if (status >= 500 && status < 600) return true;
    if (!error?.response && /timeout/i.test(error?.message || "")) return true;
    return false;
};

const withExplorerRetry = async (fn, { attempts = 3, label = "BlockDAG API" } = {}) => {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (!isRetryableExplorerError(error) || attempt === attempts) break;
            const delayMs = 400 * attempt;
            console.warn(`${label} attempt ${attempt}/${attempts} failed (${error.message}); retrying in ${delayMs}ms`);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
    throw lastError;
};

/**
 * Per-step deadlines for the wallet endpoints. The apps give each network ~8 s, so a
 * slow upstream must not hold the whole response.
 */
const EXPLORER_STEP_TIMEOUT_MS = 4000;
const RPC_STEP_TIMEOUT_MS = 5000;
const ADDRESS_STEP_TIMEOUT_MS = 5000;

/** Rejects with `<label> timeout after <ms>ms` when `promise` takes longer than `ms`. */
const withDeadline = (promise, ms, label) => {
    let timer;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
};

// BlockDAG JSON-RPC — public endpoint only (dapps-rpc.bdagscan.com is broken / blocked).
// Optional BLOCKDAG_MAIN_RPC_URL may still override; if it differs from rpcUrl we try it once then fall back.
const BLOCKDAG_PUBLIC_RPC = "https://rpc.bdagscan.com";
const BLOCKDAG_MAIN_RPC = config.blockdag?.mainRpcUrl || BLOCKDAG_PUBLIC_RPC;
const BLOCKDAG_RPC = config.blockdag?.rpcUrl || BLOCKDAG_PUBLIC_RPC;
const NOWNODES_BLOCKDAG_RPC = "https://bdag.nownodes.io";

// Process-lifetime: when a distinct mainRpcUrl fails, stop using it until process restart
let mainRpcUrlDisabled = false;
const MAIN_RPC_DISTINCT =
    String(BLOCKDAG_MAIN_RPC).replace(/\/$/, "").toLowerCase() !== String(BLOCKDAG_RPC).replace(/\/$/, "").toLowerCase();
const BLOCKDAG_TESTNET_RPC = "https://testnet-rpc.blockdag.network"; // Keep for reference if needed
const BLOCKDAG_EXPLORER = "https://bdagscan.com";
const apiForAddressBalance = "https://api.bdagscan.com/v1/api/transaction/getAddressInfo?address=";

// https://api.bdagscan.com/v1/api/transaction/getAddressInfo?address=0x1BC125bC681685f216935798453F70fb423eB392

// sample response for the apiForAddressBalance
/**
     * {
    "data": {
        "firstTransaction": {
            "txnHash": "0xd21b0a14cca435a4348f719f417835b6d2c4461f21209125fd916f3230bfcf93",
            "timestamp": "1770919479"
        },
        "lastTransaction": {
            "txnHash": "0xd21b0a14cca435a4348f719f417835b6d2c4461f21209125fd916f3230bfcf93",
            "timestamp": "1770919479"
        },
        "balance": 100
    },
    "status": 200
}
     */

const apiForAddressTransactions = "https://api.bdagscan.com/v1/api/transaction/getTransactionByAddress";
//?address=0x...&limit=10&page=1&export=false <-- those are the query parameters

// rpc.bdagscan.com and api.bdagscan.com stop answering from the API host (timeout / Cloudflare).
// These public endpoints stay in sync with chain 1404 and expose Blockscout address history.
const DEFAULT_BLOCKDAG_RPC_FALLBACKS = [
    "https://rpc.west.bdag-us.org",
    "https://rpc.east.bdag-us.org",
    "https://rpc.brazil.bdag-us.org",
    "https://rpc.blockdag.solutions",
];
const DEFAULT_BLOCKDAG_BLOCKSCOUT_URLS = [
    "https://explorer.east.bdag-us.org",
    "https://explorer.west.bdag-us.org",
    "https://explorer.brazil.bdag-us.org",
];

const splitCsv = (value) =>
    String(value || "")
        .split(",")
        .map((item) => item.trim().replace(/\/$/, ""))
        .filter(Boolean);

const blockdagRpcFallbacks = () => {
    const configured = splitCsv(process.env.BLOCKDAG_RPC_FALLBACK_URLS);
    return configured.length ? configured : DEFAULT_BLOCKDAG_RPC_FALLBACKS;
};

const blockdagBlockscoutUrls = () => {
    const configured = splitCsv(process.env.BLOCKDAG_BLOCKSCOUT_URLS);
    return configured.length ? configured : DEFAULT_BLOCKDAG_BLOCKSCOUT_URLS;
};

const HISTORY_UNAVAILABLE = "HISTORY_UNAVAILABLE";

const unavailableHistory = (page) => ({
    pagination: {
        records: "0",
        pages: "0",
        page: String(page ?? "0"),
    },
    transactions: [],
    transactionsUnavailable: true,
    error: HISTORY_UNAVAILABLE,
});

const apiForTransactionDetails = "https://api.bdagscan.com/v1/api/transaction/getTransactionDetails?txnHash=";

// sample response for the apiForAddressTransactions
/**
 * {
    "data": [
        {
            "id": 86423,
            "status": "success",
            "txnHash": "0x1c78e9bac582c9b841532a5f4191ca261b351898b2a644d0dfb3aa4e14e83bfd",
            "blockId": "e0706793-294d-4f64-967f-459043f63a60",
            "from": "0x410344ab6f949cD9F9013c52d1E59932f0f08967",
            "to": "0x787389C8ec43D94362648310316F4348A4dE8C83",
            "value": "20",
            "txnFee": "0.000000021000147",
            "txnGasPrice": "0.000000000001000007",
            "gasUsed": "21000",
            "method": "transfer",
            "logMetaData": null,
            "contractAddress": "",
            "timestamp": "1763642207",
            "createdAt": "2025-11-20T12:37:10.981Z",
            "updatedAt": "2025-11-20T12:37:10.981Z",
            "block": {
                "blockNumber": "31770339"
            }
        },
        {
            "id": 86414,
            "status": "success",
            "txnHash": "0x15e6abb31019ea785c25130165febc349544a7642b33eeaa98565d546cf7bcb7",
            "blockId": "91c99ea5-148b-4f33-adca-bf58bdd1d0e1",
            "from": "0x002aF85c8865DE4604dF07a1105EfEF2b8e0dE05",
            "to": "0x787389C8ec43D94362648310316F4348A4dE8C83",
            "value": "10",
            "txnFee": "0.000000021000147",
            "txnGasPrice": "0.000000000001000007",
            "gasUsed": "21000",
            "method": "transfer",
            "logMetaData": null,
            "contractAddress": "",
            "timestamp": "1763642026",
            "createdAt": "2025-11-20T12:34:48.863Z",
            "updatedAt": "2025-11-20T12:34:48.863Z",
            "block": {
                "blockNumber": "31768963"
            }
        },
        {
            "id": 86413,
            "status": "success",
            "txnHash": "0x58718723453c3959f530e5b4e2c080721f73827700bd6e4938563a61531e818f",
            "blockId": "a6c2cd0a-d0a3-4f93-b3c4-17a4cb48cd28",
            "from": "0x410344ab6f949cD9F9013c52d1E59932f0f08967",
            "to": "0x787389C8ec43D94362648310316F4348A4dE8C83",
            "value": "10",
            "txnFee": "0.000000021000147",
            "txnGasPrice": "0.000000000001000007",
            "gasUsed": "21000",
            "method": "transfer",
            "logMetaData": null,
            "contractAddress": "",
            "timestamp": "1763642016",
            "createdAt": "2025-11-20T12:34:42.605Z",
            "updatedAt": "2025-11-20T12:34:42.605Z",
            "block": {
                "blockNumber": "31768881"
            }
        }
    ],
    "status": 200
}
 */

// Helper function to get address balance and details from API
const getAddressBalanceFromAPI = async (address, { attempts = 3, timeout } = {}) => {
    try {
        return await withExplorerRetry(
            async () => {
                const response = await instance.get(`${apiForAddressBalance}${address}`, {
                    headers: explorerApiHeaders(),
                    ...(timeout ? { timeout } : {}),
                });

                if (response.data && response.data.status === 200 && response.data.data) {
                    const { balance, firstTransaction, lastTransaction } = response.data.data;
                    return {
                        balance: balance !== undefined && balance !== null ? balance.toString() : "0",
                        firstTransaction,
                        lastTransaction,
                    };
                }
                throw new Error("Invalid API response");
            },
            { label: "BlockDAG API balance", attempts }
        );
    } catch (error) {
        console.error("BlockDAG API balance fetch failed:", error.message);
        throw error;
    }
};

// Helper function to get address transactions from API
const getAddressTransactionsFromAPI = async (address, page = 1, limit = 20, exportData = false, { attempts = 3, timeout } = {}) => {
    try {
        return await withExplorerRetry(
            async () => {
                const response = await instance.get(apiForAddressTransactions, {
                    params: {
                        address: address,
                        page: page,
                        limit: limit,
                        export: exportData,
                    },
                    headers: explorerApiHeaders(),
                    ...(timeout ? { timeout } : {}),
                });

                if (response.data && response.data.status === 200) {
                    const data = response.data.data;
                    return Array.isArray(data) ? data : data || [];
                }
                throw new Error("Invalid API response");
            },
            { label: "BlockDAG API transactions", attempts }
        );
    } catch (error) {
        console.error("BlockDAG API transactions fetch failed:", error.message);
        throw error;
    }
};

// Helper function to get transaction details from API
const getTransactionFromAPI = async (txnHash) => {
    try {
        return await withExplorerRetry(
            async () => {
                const response = await instance.get(`${apiForTransactionDetails}${txnHash}`, {
                    headers: explorerApiHeaders(),
                });

                if (response.data && response.data.status === 200 && response.data.data) {
                    return response.data.data;
                }
                return null;
            },
            { label: "BlockDAG API tx detail", attempts: 2 }
        );
    } catch (error) {
        console.error("BlockDAG API transaction detail fetch failed:", error.message);
        return null;
    }
};

/**
 * Transform API transaction format to expected format
 * @param {Object} tx - Transaction from API
 * @param {string} address - Address to determine transaction direction
 * @returns {Object} Transformed transaction
 */
const transformApiTransaction = (tx, address) => {
    const isOutgoing = tx.from && tx.from.toLowerCase() === address.toLowerCase();
    const traffic = isOutgoing ? "OUT" : "IN";
    const method = tx.method || (tx.contractAddress && tx.contractAddress !== "" ? "Contract" : "Transfer");

    // Parse timestamp
    let date = "N/A";
    let age = "N/A";
    if (tx.timestamp) {
        const timestamp = typeof tx.timestamp === "string" ? parseInt(tx.timestamp, 10) : tx.timestamp;
        date = moment.unix(timestamp).format("YYYY-MM-DD HH:mm:ss");
        age = moment.unix(timestamp).fromNow();
    }

    return {
        hash: tx.txnHash || "0x" + "0".repeat(64),
        method: method,
        block: tx.block?.blockNumber || "N/A",
        age: age,
        date: date,
        from: tx.from || address,
        traffic: traffic,
        to: tx.to || address,
        fiatAmount: "0.00",
        amount: tx.value || "0",
        asset: "BDAG",
        txnFee: tx.txnFee || "0",
        note: tx.note || "",
        status: tx.status || "success",
    };
};

/**
 * Post JSON-RPC request to a given URL
 * @param {string} url - RPC endpoint URL
 * @param {string} method - RPC method
 * @param {Array} params - RPC parameters
 * @param {Object} [extraHeaders] - Optional extra headers (e.g. api-key for NowNodes)
 * @returns {Promise<Object>} RPC response data
 */
const postToRpc = async (url, method, params, extraHeaders = {}, timeout = 2000) => {
    const response = await instance.post(
        url,
        { jsonrpc: "2.0", method, params, id: 1 },
        { headers: { "Content-Type": "application/json", ...extraHeaders }, timeout }
    );
    return response.data;
};

/**
 * Centralized RPC request handler with optional NowNodes, then public rpcUrl.
 * If BLOCKDAG_MAIN_RPC_URL is set to a distinct host, try it first then fall back to rpcUrl.
 * @param {string} method - RPC method
 * @param {Array} params - RPC parameters
 * @returns {Promise<Object>} RPC response data
 */
const requestRPC = async (method, params = []) => {
    const nowNodesAPIKey = config.blockdag?.nowNodesAPIKey;

    if (nowNodesAPIKey) {
        try {
            const data = await postToRpc(NOWNODES_BLOCKDAG_RPC, method, params, { "api-key": nowNodesAPIKey });
            if (data && !data.error) {
                return data;
            }
            if (data?.error) {
                console.warn(`NowNodes RPC error for ${method}:`, data.error.message);
            }
        } catch (error) {
            console.warn(`NowNodes RPC connection failed for ${method}:`, error.message);
        }
    }

    // Only attempt a separate main URL when it differs from the public/fallback RPC
    if (MAIN_RPC_DISTINCT && !mainRpcUrlDisabled) {
        try {
            const data = await postToRpc(BLOCKDAG_MAIN_RPC, method, params);
            if (data && !data.error) {
                return data;
            }
            if (data?.error) {
                console.warn(`BlockDAG mainRpcUrl RPC error for ${method}:`, data.error.message);
            }
            mainRpcUrlDisabled = true;
        } catch (error) {
            console.warn(`BlockDAG mainRpcUrl failed for ${method}:`, error.message);
            mainRpcUrlDisabled = true;
        }
    }

    const urls = [];
    const pushUrl = (url) => {
        const normalized = String(url || "").trim().replace(/\/$/, "");
        if (!normalized) return;
        if (urls.some((existing) => existing.replace(/\/$/, "").toLowerCase() === normalized.toLowerCase())) return;
        urls.push(normalized);
    };

    pushUrl(BLOCKDAG_RPC);
    for (const url of blockdagRpcFallbacks()) pushUrl(url);

    let last = null;
    for (const url of urls) {
        try {
            const data = await postToRpc(url, method, params);
            if (data && !data.error) return data;
            last = data;
        } catch (error) {
            console.warn(`BlockDAG RPC failed for ${method} via fallback:`, error.message);
            last = { error: { message: error.message } };
        }
    }

    return last || { error: { message: "RPC request failed" } };
};

/**
 * Transform RPC transaction format to expected format
 * @param {Object} tx - Transaction from RPC
 * @param {string} address - Address to determine transaction direction
 * @returns {Object} Transformed transaction
 */
const transformRpcTransaction = (tx, address) => {
    // Parse transaction data
    const value = tx.value ? (parseInt(tx.value, 16) / Math.pow(10, 18)).toFixed(6) : "0";
    const gasPrice = tx.gasPrice ? parseInt(tx.gasPrice, 16) : 0;
    const gasUsed = tx.gasUsed ? parseInt(tx.gasUsed, 16) : 0;
    const txnFee = (gasPrice * gasUsed) / Math.pow(10, 18);

    // Determine transaction type/direction
    const isOutgoing = tx.from && tx.from.toLowerCase() === address.toLowerCase();
    const traffic = isOutgoing ? "OUT" : "IN";
    const method = tx.input && tx.input !== "0x" && tx.input.length > 10 ? "Contract" : "Transfer";

    // Get block timestamp if available
    let date = "N/A";
    let age = "N/A";
    if (tx.timestamp) {
        const timestamp = typeof tx.timestamp === "string" ? parseInt(tx.timestamp, 16) : tx.timestamp;
        date = moment.unix(timestamp).format("YYYY-MM-DD HH:mm:ss");
        age = moment.unix(timestamp).fromNow();
    } else if (tx.blockNumber) {
        // If we have block number but no timestamp, we can't calculate age accurately
        date = "N/A";
        age = "N/A";
    }

    return {
        hash: tx.hash || tx.transactionHash || "0x" + "0".repeat(64),
        method: method,
        block: tx.blockNumber ? (typeof tx.blockNumber === "string" ? parseInt(tx.blockNumber, 16) : tx.blockNumber).toString() : "N/A",
        age: age,
        date: date,
        from: tx.from || address,
        traffic: traffic,
        to: tx.to || address,
        fiatAmount: "0.00",
        amount: value,
        asset: "BDAG",
        txnFee: txnFee.toFixed(6),
        note: tx.note || "",
    };
};

/**
 * Fetch transactions from RPC endpoint
 * @param {string} address - Address to fetch transactions for
 * @returns {Array} Array of raw RPC transactions
 */
const fetchTransactionsFromRPC = async (address) => {
    let response = null;
    try {
        response = await requestRPC("getAddressTxs", [address]);
    } catch (testnetError) {
        console.log("NowNodes or primary RPC failed, trying fallback logic if any:", testnetError.message);
        // The requestRPC already handled the fallback to BLOCKDAG_RPC.
        // If we reach here, it means both failed or returned an error.
        throw testnetError;
    }

    if (!response || response.error) {
        const errorCode = response?.error?.code;

        // -32601 es "method not found". `getAddressTxs` no es un metodo del estandar
        // JSON-RPC de EVM y la red no lo expone, asi que este camino se toma siempre.
        // Antes se logueaba "Returning empty transactions" pero igual se lanzaba, con
        // lo cual el fallo se propagaba y tumbaba toda la consulta de la red: el saldo
        // tampoco se mostraba, aunque se hubiera obtenido sin problema.
        //
        // Devolver una lista vacia degrada de forma correcta: la wallet muestra el
        // saldo y el historial queda vacio, en vez de no mostrar nada.
        if (errorCode === -32601) {
            console.log("BlockDAG: el nodo no expone getAddressTxs; historial vacio.");
            return [];
        }

        console.error("RPC error:", response?.data?.error || "Unknown error");
        throw new Error(response?.data?.error?.message || "RPC request failed");
    }

    return response.data.result || [];
};

// Helper function to get latest block number
const getLatestBlock = async () => {
    try {
        const data = await requestRPC("eth_blockNumber");
        if (!data?.result) throw new Error(data?.error?.message || "RPC request failed");
        return parseInt(data.result, 16);
    } catch (error) {
        console.error("BlockDAG getLatestBlock error:", error.message);
        return 0;
    }
};

/**
 * Fetch BDAG balance: prefer explorer API (includes first/last tx), fall back to RPC eth_getBalance.
 * @param {string} address - Address to fetch balance for
 * @returns {Promise<Object>} Object containing balance and transaction stats
 */
const fetchBdagBalance = async (address) => {
    // The explorer API (api.bdagscan.com) can hang for minutes. With 3 attempts of 15 s
    // it took ~46 s before falling back to the RPC, longer than any client waits.
    // Ask both at once: the RPC answers the balance in ~0.1 s, and the explorer only
    // adds first/last transaction when it answers within its short deadline.
    const [explorer, rpc] = await Promise.allSettled([
        withDeadline(
            getAddressBalanceFromAPI(address, { attempts: 1, timeout: EXPLORER_STEP_TIMEOUT_MS }),
            EXPLORER_STEP_TIMEOUT_MS,
            "BlockDAG API balance"
        ),
        withDeadline(requestRPC("eth_getBalance", [address, "latest"]), RPC_STEP_TIMEOUT_MS, "BlockDAG RPC balance"),
    ]);

    if (explorer.status === "fulfilled" && explorer.value) return explorer.value;

    if (rpc.status === "fulfilled" && rpc.value?.result) {
        return {
            balance: (parseInt(rpc.value.result, 16) / Math.pow(10, 18)).toString(),
            firstTransaction: null,
            lastTransaction: null,
        };
    }

    console.error(
        "BlockDAG balance unavailable:",
        explorer.reason?.message || "explorer empty",
        "/",
        rpc.reason?.message || "rpc empty"
    );
    return { balance: "0", firstTransaction: null, lastTransaction: null };
};

/**
 * Fetch BDAG price from API
 * @returns {Promise<string>} Price as string
 */
const fetchBDAGPrice = async () => {
    try {
        const response = await axios.get("https://api.blockdagnetwork.io/api/v2/base/public/current_price", {
            headers: {
                "Content-Type": "application/json",
                "User-Agent": generateRandomUserAgent(),
            },
            httpsAgent: agent,
            timeout: 5000,
        });

        if (response.data && response.data.price) {
            return response.data.price.toString();
        }

        return "0.00001805"; // Default fallback if API structure changes
    } catch (error) {
        console.log("BlockDAG price fetch failed, using default:", error.message);
        return "0.00001805"; // Placeholder price
    }
};

/**
 * Fetch tokens for an address
 * @param {string} address - Address to fetch tokens for
 * @returns {Promise<Object>} Object with tokens array and totalFiatBalance
 */
const fetchAddressTokens = async (address) => {
    try {
        const tokensData = await getTokens({ address }, { show: "100" });
        return {
            tokens: tokensData.tokens || [],
            totalFiatBalance: tokensData.totalFiatBalance || 0,
        };
    } catch (error) {
        console.error("BlockDAG tokens fetch failed:", error.message);
        return {
            tokens: [],
            totalFiatBalance: 0,
        };
    }
};

/**
 * Create native BDAG token object
 * @param {string} address - Wallet address
 * @param {string} balance - BDAG balance
 * @param {string} price - BDAG price
 * @param {number} fiatBalance - Fiat balance value
 * @returns {Object} Native BDAG token object
 */
const createNativeBdagToken = (address, balance, price, fiatBalance) => {
    return {
        tokenType: "BDAG",
        fiatBalance: fiatBalance,
        symbol: "BDAG",
        name: "BlockDAG",
        price: price,
        amount: balance,
        image: "https://arweave.net/C3UN6v_nJT81_3dhsIw5dGP0kjPTfUu6LSDqRwmW0OQ",
        address: address,
        decimals: 18,
    };
};

/**
 * Latest transactions for the wallet history: one short attempt against the explorer.
 * The RPC has no address-history method (`getAddressTxs` is not exposed), so when the
 * explorer is down the list is empty and `available` is false. It used to return a fake
 * "Error" transaction that the apps rendered as a real movement.
 * @param {string} address
 * @returns {Promise<{ transactions: Array, available: boolean }>}
 */
const formatWei = (wei) => {
    try {
        const value = BigInt(String(wei || "0"));
        const negative = value < 0n;
        const absolute = negative ? -value : value;
        const base = 10n ** 18n;
        const whole = absolute / base;
        const fraction = (absolute % base).toString().padStart(18, "0").replace(/0+$/, "");
        const text = fraction ? `${whole.toString()}.${fraction}` : whole.toString();
        return negative ? `-${text}` : text;
    } catch (error) {
        return "0";
    }
};

const blockscoutAddress = (field) => {
    if (!field) return "";
    if (typeof field === "string") return field;
    if (typeof field === "object" && field.hash) return field.hash;
    return "";
};

const transformBlockscoutTransaction = (tx, address) => {
    const from = blockscoutAddress(tx.from) || address;
    const to = blockscoutAddress(tx.to) || address;
    const traffic = from.toLowerCase() === String(address).toLowerCase() ? "OUT" : "IN";
    const parsed = Date.parse(tx.timestamp || "");
    const timestamp = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
    const date = timestamp ? moment.unix(timestamp).utc().format("YYYY-MM-DD HH:mm:ss") : "N/A";

    return {
        hash: tx.hash || "0x" + "0".repeat(64),
        method: tx.method || (tx.raw_input && tx.raw_input !== "0x" ? "Contract" : "Transfer"),
        block: tx.block_number || tx.block || "N/A",
        age: timestamp ? moment.unix(timestamp).fromNow() : "N/A",
        date,
        timestamp,
        from,
        traffic,
        to,
        fiatAmount: "0.00",
        amount: formatWei(tx.value),
        asset: "BDAG",
        txnFee: tx.fee?.value != null ? formatWei(tx.fee.value) : "0",
        status: tx.status === "ok" || tx.result === "success" ? "success" : tx.status || tx.result || "success",
    };
};

/**
 * Blockscout pages are newest-first. Walk only as far as the requested window.
 * @returns {Promise<{ transactions: Array, hasNextPage: boolean, source: string }>}
 */
const fetchBlockscoutTransactionPage = async (address, pageNum, showNum) => {
    const needed = (pageNum + 1) * showNum;
    let lastError = null;

    for (const base of blockdagBlockscoutUrls()) {
        try {
            const url = `${base}/api/v2/addresses/${address}/transactions`;
            let items = [];
            let next = null;
            let guard = 0;

            while (items.length < needed && guard < 4) {
                const response = await instance.get(url, {
                    params: next || undefined,
                    timeout: 4000,
                    headers: { Accept: "application/json", "User-Agent": generateRandomUserAgent() },
                    validateStatus: (status) => status < 500,
                });

                if (response.status >= 400) throw new Error(`Blockscout HTTP ${response.status}`);

                const batch = Array.isArray(response.data?.items) ? response.data.items : null;
                if (!batch) throw new Error("Blockscout response missing items");

                items = items.concat(batch);
                next = response.data?.next_page_params || null;
                guard += 1;
                if (!next || batch.length === 0) break;
            }

            const start = pageNum * showNum;
            return {
                transactions: items.slice(start, start + showNum).map((tx) => transformBlockscoutTransaction(tx, address)),
                hasNextPage: items.length > start + showNum || Boolean(next),
                source: "blockscout",
            };
        } catch (error) {
            lastError = error;
            console.warn(`BlockDAG Blockscout ${base} failed:`, error.message);
        }
    }

    throw lastError || new Error(HISTORY_UNAVAILABLE);
};

/**
 * bdagscan first, then a synced Blockscout, then the RPC method when a node actually exposes it.
 * Throws HISTORY_UNAVAILABLE when every source fails. An empty list from a source that answered is real.
 */
const loadTransactionPage = async (address, pageNum, showNum) => {
    try {
        const apiTransactions = await getAddressTransactionsFromAPI(address, pageNum + 1, showNum, false, {
            attempts: 1,
            timeout: 2500,
        });
        const rows = (Array.isArray(apiTransactions) ? apiTransactions : []).map((tx) => transformApiTransaction(tx, address));
        return { transactions: rows, hasNextPage: rows.length >= showNum, source: "bdagscan" };
    } catch (error) {
        console.log("BlockDAG API transactions fetch failed, trying Blockscout:", error.message);
    }

    try {
        return await fetchBlockscoutTransactionPage(address, pageNum, showNum);
    } catch (error) {
        console.warn("BlockDAG Blockscout history failed:", error.message);
    }

    try {
        const rpcTransactions = await fetchTransactionsFromRPC(address);
        if (rpcTransactions.length) {
            const start = pageNum * showNum;
            return {
                transactions: rpcTransactions.slice(start, start + showNum).map((tx) => transformRpcTransaction(tx, address)),
                hasNextPage: rpcTransactions.length > start + showNum,
                source: "rpc",
            };
        }
    } catch (error) {
        console.warn("BlockDAG RPC history failed:", error.message);
    }

    throw new Error(HISTORY_UNAVAILABLE);
};

const fetchAddressTransactions = async (address) => {
    try {
        const page = await withDeadline(loadTransactionPage(address, 0, 20), ADDRESS_STEP_TIMEOUT_MS, "BlockDAG API transactions");
        return { transactions: page.transactions, available: true };
    } catch (error) {
        console.warn("BlockDAG history unavailable:", error.message);
        return { transactions: [], available: false };
    }
};

/**
 * Build address response object
 * @param {string} address - Wallet address
 * @param {string} balance - BDAG balance
 * @param {string} price - BDAG price
 * @param {number} fiatBalance - Fiat balance
 * @param {Array} tokens - Array of tokens
 * @param {Array} transactions - Array of transactions
 * @param {number} totalFiatBalance - Total fiat balance from tokens
 * @returns {Object} Complete address response object
 */
const buildAddressResponse = (
    address,
    balance,
    price,
    fiatBalance,
    tokens,
    transactions,
    totalFiatBalance,
    firstTransaction = null,
    lastTransaction = null
) => {
    const totalPortfolioValue = fiatBalance + totalFiatBalance;

    return {
        address,
        balance,
        fiatBalance,
        totalPortfolioValue,
        price,
        type: "system_account",
        firstTransaction,
        lastTransaction,
        account: {
            asset: "BDAG",
            fiatBalance: fiatBalance.toString(),
            price,
        },
        tokenHoldings: {
            total: tokens.length,
            balance: (fiatBalance + totalFiatBalance).toString(),
            tokens,
        },
        transactions,
    };
};

/**
 * Get comprehensive address information for BlockDAG
 *
 * Balance, price, tokens and history run in parallel, each with its own deadline, so
 * the answer arrives in ~5 s at worst. It used to run them one after another behind a
 * 30 s cap: with the explorer hanging it always took 30 s and the apps, which wait ~8 s,
 * showed BlockDAG as failed (#580).
 * @param {Object} query - Query parameters containing address
 * @returns {Object} Address data with balance, tokens, and transactions
 */
const getAddress = async (query) => {
    try {
        const { address } = query;

        const [bdagData, bdagPrice, tokensData, history] = await Promise.all([
            fetchBdagBalance(address),
            fetchBDAGPrice(),
            withDeadline(fetchAddressTokens(address), ADDRESS_STEP_TIMEOUT_MS, "BlockDAG tokens").catch((error) => {
                console.warn(error.message);
                return { tokens: [], totalFiatBalance: 0 };
            }),
            fetchAddressTransactions(address),
        ]);

        const bdagBalance = bdagData.balance;
        const fiatBalance = parseFloat(bdagBalance) * parseFloat(bdagPrice);

        const tokens = [...tokensData.tokens];
        tokens.unshift(createNativeBdagToken(address, bdagBalance, bdagPrice, fiatBalance));

        return {
            ...buildAddressResponse(
                address,
                bdagBalance,
                bdagPrice,
                fiatBalance,
                tokens,
                history.transactions,
                tokensData.totalFiatBalance,
                bdagData.firstTransaction,
                bdagData.lastTransaction
            ),
            transactionsUnavailable: !history.available,
        };
    } catch (error) {
        console.error("BlockDAG getAddress error:", error.message || "Unknown error");
        return {
            error: "Failed to fetch address data",
            message: error.message,
        };
    }
};

/**
 * Get ERC20 tokens for a BlockDAG address
 * @param {Object} params - Parameters containing address
 * @param {Object} query - Query parameters for pagination
 * @returns {Object} Token holdings data
 */
const getTokens = async (params, query) => {
    try {
        const { address } = params;

        // Try to get common/popular BlockDAG tokens via RPC
        const commonTokens = require("../data/common-tokens.json");

        if (commonTokens.length === 0) {
            // No common tokens configured yet
            return {
                balance: "0",
                total: 0,
                totalFiatBalance: 0,
                tokens: [],
            };
        }

        const tokens = [];
        let totalFiatBalance = 0;

        for (const token of commonTokens) {
            try {
                // Get token balance using ERC20 balanceOf function via RPC
                const data = await requestRPC("eth_call", [
                    {
                        to: token.contractAddress,
                        data: "0x70a08231" + "000000000000000000000000" + address.slice(2), // balanceOf(address)
                    },
                    "latest",
                ]);

                if (data.result && data.result !== "0x" && data.result !== "0x0") {
                    const balance = parseInt(data.result, 16);
                    if (balance > 0) {
                        const amount = balance / Math.pow(10, token.decimals);
                        const price = token.price || "0";
                        const fiatBalance = amount * parseFloat(price);

                        tokens.push({
                            address: token.contractAddress,
                            symbol: token.symbol,
                            name: token.name,
                            decimals: token.decimals,
                            amount: amount.toString(),
                            price: price,
                            fiatBalance: fiatBalance,
                            image: token.image || "https://arweave.net/C3UN6v_nJT81_3dhsIw5dGP0kjPTfUu6LSDqRwmW0OQ",
                            tokenType: "ERC20",
                            owner: address,
                            contractAddress: token.contractAddress,
                            rawAmount: balance.toString(),
                        });

                        totalFiatBalance += fiatBalance;
                    }
                }
            } catch (tokenError) {
                console.log(`Error fetching token ${token.symbol}:`, tokenError.message);
                // Continue with next token if one fails
                continue;
            }
        }

        return {
            balance: totalFiatBalance.toFixed(2),
            total: tokens.length,
            totalFiatBalance: totalFiatBalance,
            tokens: tokens,
        };
    } catch (error) {
        console.error("Error getting BlockDAG tokens:", error.message || "Unknown error");
        return {
            balance: "0",
            total: 0,
            totalFiatBalance: 0,
            tokens: [],
        };
    }
};

/**
 * Get transaction list for a BlockDAG address
 * @param {Object} query - Query parameters containing address, page, and show
 * @returns {Array} Array of transactions
 */
const getTransactionsList = async (query) => {
    const page = query?.page ?? "0";

    try {
        const { address, show = "20" } = query;
        const pageNum = parseInt(page, 10);
        const showNum = parseInt(show, 10);
        const safePage = Number.isFinite(pageNum) && pageNum >= 0 ? pageNum : 0;
        const safeShow = Number.isFinite(showNum) && showNum > 0 ? showNum : 20;
        const pageResult = await loadTransactionPage(address, safePage, safeShow);

        return {
            pagination: {
                records: pageResult.transactions.length.toString(),
                pages: pageResult.hasNextPage ? String(safePage + 2) : String(safePage + 1),
                page: String(safePage),
                hasNextPage: Boolean(pageResult.hasNextPage),
            },
            hasNextPage: Boolean(pageResult.hasNextPage),
            source: pageResult.source,
            transactions: pageResult.transactions,
        };
    } catch (error) {
        console.error("Error getting BlockDAG transactions:", error.message || "Unknown error");
        return unavailableHistory(page);
    }
};

/**
 * Get transaction status/details for a BlockDAG transaction
 * @param {Object} params - Parameters containing transaction ID
 * @returns {Object} Transaction details
 */
const getTransactionStatus = async (params) => {
    try {
        const { id, address } = params;

        // Try API first
        const apiTx = await getTransactionFromAPI(id);

        if (apiTx) {
            return {
                blockNumber: apiTx.block?.blockNumber ? parseInt(apiTx.block?.blockNumber) : "N/A",
                confirmations: apiTx.status === "success" ? "1" : "0",
                from: apiTx.from,
                to: apiTx.to,
                traffic: `${address}`.length > 20 ? (apiTx.to === address ? "IN" : "OUT") : undefined,
                value: apiTx.value ? parseFloat(apiTx.value).toFixed(6) : "0",
                gas: "21000", // Default or parsed if available
                gasPrice: apiTx.txnGasPrice ? Math.floor(parseFloat(apiTx.txnGasPrice) * 1e18) : "0",
                gasUsed: apiTx.gasUsed ? parseInt(apiTx.gasUsed) : "0",
                nonce: "0", // Not usually provided in this API response
                input: "0x", // Not usually provided in this API response
                hash: apiTx.txnHash,
                status: apiTx.status === "success" ? "success" : apiTx.status === "failed" ? "failed" : "pending",
                transactionIndex: "0",
            };
        }

        // Fallback to RPC
        console.log("Transaction not found in API, falling back to RPC...");

        // Get transaction details via RPC
        const data = await requestRPC("eth_getTransactionByHash", [id]);

        // If transaction not found, it might be dropped or never existed
        if (!data.result || data.result === null) {
            return {
                error: "Transaction not found",
                status: "dropped",
                hash: id,
            };
        }

        const tx = response.data.result;

        // Get transaction receipt for status
        let receipt = null;
        try {
            const data = await requestRPC("eth_getTransactionReceipt", [id]);
            receipt = data.result;
        } catch (receiptError) {
            console.log("Receipt fetch failed:", receiptError.message);
        }

        // Determine transaction status
        let status = "pending";
        if (receipt) {
            // If receipt exists, check status field
            if (receipt.status === "0x1" || receipt.status === 1) {
                status = "success";
            } else if (receipt.status === "0x0" || receipt.status === 0) {
                status = "failed";
            } else {
                status = "pending";
            }
        } else if (tx.blockNumber) {
            // Transaction is in a block but no receipt yet (shouldn't happen normally)
            // Check if transaction is in a block - if yes, assume success for now
            // But ideally we should have a receipt
            status = "pending";
        } else {
            // Transaction exists but not in a block - check if it's been pending too long
            // For now, mark as pending
            status = "pending";
        }

        return {
            blockNumber: tx.blockNumber ? parseInt(tx.blockNumber, 16) : "N/A",
            confirmations: receipt ? "1" : "0",
            from: tx.from,
            to: tx.to,
            value: tx.value ? (parseInt(tx.value, 16) / Math.pow(10, 18)).toFixed(6) : "0",
            gas: tx.gas ? parseInt(tx.gas, 16) : "0",
            gasPrice: tx.gasPrice ? parseInt(tx.gasPrice, 16) : "0",
            gasUsed: receipt && receipt.gasUsed ? parseInt(receipt.gasUsed, 16) : "0",
            nonce: tx.nonce ? parseInt(tx.nonce, 16) : "0",
            input: tx.input || "0x",
            hash: tx.hash,
            status: status,
            transactionIndex: tx.transactionIndex ? parseInt(tx.transactionIndex, 16) : "0",
        };
    } catch (error) {
        console.error("Error getting BlockDAG transaction status:", error.message || "Unknown error");
        return { error: "Failed to fetch transaction status", status: "error" };
    }
};

/**
 * Get portfolio summary for a BlockDAG address
 * @param {Object} params - Parameters containing address
 * @returns {Object} Portfolio summary data
 */
const getPortfolioSummary = async (params) => {
    try {
        const { address } = params;

        // Get BDAG balance and price
        let bdagBalance = "0";
        let bdagPrice = "0.005"; // Default placeholder
        try {
            const data = await requestRPC("eth_getBalance", [address, "latest"]);
            bdagBalance = data.result ? (parseInt(data.result, 16) / Math.pow(10, 18)).toString() : "0";

            try {
                const priceData = await getTickerPrice({ symbol: "BDAG" });

                bdagPrice = priceData.price || "0.005";
            } catch (priceError) {
                console.log("Price fetch failed, using default");
            }
        } catch (error) {
            console.error("Portfolio summary BDAG data fetch failed:", error.message);
        }

        // Get all tokens
        const tokensData = await getTokens({ address }, { show: "100" });
        const tokens = tokensData.tokens || [];
        const totalTokenValue = tokensData.totalFiatBalance || 0;

        // Calculate total portfolio value
        const bdagValue = parseFloat(bdagBalance) * parseFloat(bdagPrice);
        const totalPortfolioValue = bdagValue + totalTokenValue;

        // Get transaction count
        let transactionCount = 0;
        try {
            const data = await requestRPC("eth_getTransactionCount", [address, "latest"]);
            transactionCount = data.result ? parseInt(data.result, 16) : 0;
        } catch (error) {
            console.error("Transaction count fetch failed:", error.message);
        }

        return {
            address,
            totalPortfolioValue: totalPortfolioValue.toFixed(2),
            bdagBalance: parseFloat(bdagBalance).toFixed(8),
            bdagValue: bdagValue.toFixed(2),
            bdagPrice: bdagPrice,
            tokenCount: tokens.length,
            totalTokenValue: totalTokenValue.toFixed(2),
            transactionCount,
            tokens,
            lastUpdated: new Date().toISOString(),
        };
    } catch (error) {
        console.error("Error getting BlockDAG portfolio summary:", error.message || "Unknown error");
        return { error: "Failed to fetch portfolio summary" };
    }
};

/**
 * Get gas tracker information for BlockDAG
 * @param {Object} query - Query parameters
 * @returns {Object} Gas tracker data
 */
const getGasTracker = async (query) => {
    try {
        // Get gas price from RPC
        const data = await requestRPC("eth_gasPrice");

        const gasPrice = data.result ? parseInt(data.result, 16) / Math.pow(10, 9) : 0;

        return {
            SafeLow: Math.floor(gasPrice * 0.8),
            Standard: Math.floor(gasPrice),
            Fast: Math.floor(gasPrice * 1.2),
            Fastest: Math.floor(gasPrice * 1.5),
            safeLowWait: "1-2",
            standardWait: "1",
            fastWait: "1",
            fastestWait: "1",
        };
    } catch (error) {
        console.error("Error getting BlockDAG gas tracker:", error.message || "Unknown error");
        return { error: "Failed to fetch gas tracker data" };
    }
};

module.exports = {
    getAddress,
    getTokens,
    getTransactionsList,
    getTransactionStatus,
    getGasTracker,
    getPortfolioSummary,
    getLatestBlock,
    fetchBDAGPrice,
    fetchBdagBalance,
};
