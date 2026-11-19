/**
 * Compatibility lane for published native builds that call POST /api/rpc/:chainKey
 * without a session. Off unless RPC_ALLOW_SESSIONLESS_APPS=true, and off again
 * after RPC_SESSIONLESS_SUNSET. Read on each request.
 */

const SESSIONLESS_CHAINS = new Set(["ethereum", "avalanche", "polygon", "bsc"]);

const SESSIONLESS_METHOD_LIST = [
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
    "eth_getLogs",
    "eth_getTransactionByHash",
    "eth_getTransactionCount",
    "eth_getTransactionReceipt",
    "eth_maxPriorityFeePerGas",
    "eth_sendRawTransaction",
    "net_version",
];

const SESSIONLESS_METHODS = new Map(SESSIONLESS_METHOD_LIST.map((name) => [name.toLowerCase(), name]));

const MAX_BATCH = 3;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const sunsetDeadline = (sunset) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(sunset)) {
        const end = Date.parse(`${sunset}T23:59:59.999Z`);
        return Number.isFinite(end) ? end : null;
    }

    const instant = Date.parse(sunset);
    return Number.isFinite(instant) ? instant : null;
};

/**
 * A YYYY-MM-DD sunset stays on through the end of that UTC day.
 * An unparseable value keeps the lane off.
 */
const isSessionlessLaneActive = (env = process.env, now = new Date()) => {
    if (String(env.RPC_ALLOW_SESSIONLESS_APPS || "").trim().toLowerCase() !== "true") return false;

    const sunset = String(env.RPC_SESSIONLESS_SUNSET || "").trim();
    if (!sunset) return true;

    const deadline = sunsetDeadline(sunset);
    if (deadline == null) return false;

    return now.getTime() <= deadline;
};

const getLogsMaxBlocks = (env = process.env) => {
    const n = Number(env.RPC_SESSIONLESS_GETLOGS_MAX_BLOCKS);
    if (Number.isFinite(n) && n >= 1) return Math.min(Math.floor(n), 10000);
    return 1000;
};

const parseBlockNumber = (value) => {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0 && Number.isSafeInteger(value)) return value;
    if (typeof value !== "string") return null;

    const text = value.trim();
    if (/^0x[0-9a-f]+$/i.test(text)) {
        const parsed = Number.parseInt(text, 16);
        return Number.isSafeInteger(parsed) ? parsed : null;
    }
    if (/^[0-9]+$/.test(text)) {
        const parsed = Number(text);
        return Number.isSafeInteger(parsed) ? parsed : null;
    }

    return null;
};

const hasLogAddress = (address) => {
    if (typeof address === "string") return ADDRESS_RE.test(address);
    if (!Array.isArray(address) || address.length === 0 || address.length > 10) return false;
    return address.every((item) => typeof item === "string" && ADDRESS_RE.test(item));
};

/**
 * eth_getLogs is allowed only with an address and a numeric block span.
 * Tags such as "latest" are rejected because the span cannot be checked here.
 */
const inspectLogFilter = (params, env = process.env) => {
    if (!Array.isArray(params) || params.length !== 1 || !params[0] || typeof params[0] !== "object" || Array.isArray(params[0])) {
        return { code: "RPC_SESSIONLESS_LOG_FILTER", message: "eth_getLogs requires one filter object." };
    }

    const filter = params[0];
    if (!hasLogAddress(filter.address)) {
        return { code: "RPC_SESSIONLESS_LOG_FILTER", message: "eth_getLogs requires an address." };
    }

    const from = parseBlockNumber(filter.fromBlock);
    const to = parseBlockNumber(filter.toBlock);
    if (from == null || to == null || to < from) {
        return { code: "RPC_SESSIONLESS_LOG_RANGE", message: "eth_getLogs requires numeric fromBlock and toBlock." };
    }

    const max = getLogsMaxBlocks(env);
    if (to - from + 1 > max) {
        return { code: "RPC_SESSIONLESS_LOG_RANGE", message: `eth_getLogs block span exceeds ${max}.` };
    }

    return null;
};

const canonicalSessionlessMethod = (method) => SESSIONLESS_METHODS.get(String(method || "").trim().toLowerCase()) || null;

const hasAuthorization = (ctx) => String(ctx.get?.("authorization") || ctx.headers?.authorization || "").trim().length > 0;

const originOf = (ctx) => String(ctx.get?.("origin") || ctx.headers?.origin || "").trim();

const reject = (status, code, message) => ({ action: "reject", status, code, message });

/**
 * @returns {{action: "pass"} | {action: "reject", status: number, code: string, message: string} | {action: "forward", chain: string, calls: Array<{method: string, params: unknown, id: unknown}>, batch: boolean}}
 */
const decideSessionless = (ctx, env = process.env, now = new Date()) => {
    if (hasAuthorization(ctx) || !isSessionlessLaneActive(env, now)) {
        return { action: "pass" };
    }

    const chain = String(ctx.params?.chainKey || "").trim().toLowerCase();
    if (chain === "chains" || chain === "request") {
        return { action: "pass" };
    }

    if (originOf(ctx)) {
        return reject(403, "RPC_SESSIONLESS_ORIGIN_NOT_ALLOWED", "This compatibility lane accepts requests with no Origin header.");
    }

    if (!SESSIONLESS_CHAINS.has(chain)) {
        return reject(400, "RPC_SESSIONLESS_CHAIN_NOT_ALLOWED", "This compatibility lane allows ethereum, avalanche, polygon, and bsc.");
    }

    const body = ctx.request?.body;
    const batch = Array.isArray(body);
    if (batch && body.length === 0) {
        return reject(400, "RPC_SESSIONLESS_BATCH_INVALID", "JSON-RPC batch is empty.");
    }
    if (batch && body.length > MAX_BATCH) {
        return reject(400, "RPC_SESSIONLESS_BATCH_TOO_LARGE", "JSON-RPC batch is limited to 3 calls.");
    }
    if (!batch && (body == null || typeof body !== "object")) {
        return reject(400, "RPC_SESSIONLESS_REQUEST_INVALID", "JSON-RPC body must be an object.");
    }

    const items = batch ? body : [body];
    const calls = [];

    for (const item of items) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            return reject(400, "RPC_SESSIONLESS_REQUEST_INVALID", "Each JSON-RPC call must be an object.");
        }

        const canonical = canonicalSessionlessMethod(item.method);
        if (!canonical) {
            return reject(403, "RPC_SESSIONLESS_METHOD_NOT_ALLOWED", "RPC method is not available on the compatibility lane.");
        }

        const params = item.params == null ? [] : item.params;
        if (canonical === "eth_getLogs") {
            const problem = inspectLogFilter(params, env);
            if (problem) return reject(400, problem.code, problem.message);
        }

        calls.push({
            method: canonical,
            params,
            id: item.id !== undefined ? item.id : null,
        });
    }

    return { action: "forward", chain, calls, batch };
};

module.exports = {
    MAX_BATCH,
    SESSIONLESS_CHAINS,
    SESSIONLESS_METHOD_LIST,
    canonicalSessionlessMethod,
    decideSessionless,
    getLogsMaxBlocks,
    inspectLogFilter,
    isSessionlessLaneActive,
};
