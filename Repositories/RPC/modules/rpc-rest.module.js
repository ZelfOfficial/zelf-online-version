const config = require("../../../Core/config");
const { getCleanInstance } = require("../../../Core/axios");
const RpcLog = require("../models/rpc-log.model");
const RpcCallerModule = require("../../RPCCaller/modules/rpc-caller.module");
const {
    UPSTREAM_RESPONSE_MAX_BYTES,
    bitcoinUpstream,
    isUpstreamResponseTooLarge,
    maxBodyBytes,
    redactSecrets,
    sanitizeUpstreamBody,
    stellarUpstream,
} = require("../../../Core/rpc-upstreams");

const BTC_ADDRESS = /^(?:bc1|tb1|[123mn])[a-zA-HJ-NP-Z0-9]{14,90}$/;
const TXID = /^[a-fA-F0-9]{64}$/;
const BLOCK_ID = /^(?:\d{1,10}|[a-fA-F0-9]{64})$/;
const STELLAR_ACCOUNT = /^G[A-Z2-7]{55}$/;
const STELLAR_XDR = /^[A-Za-z0-9+/=]{32,20000}$/;
const HEX_TX = /^[a-fA-F0-9]{20,200000}$/;

const http = () =>
    getCleanInstance(config.rpc?.timeoutMs || 45000);

const fail = (status, message, clientCode) => {
    const error = new Error(message);
    error.status = status;
    if (clientCode) error.clientCode = clientCode;
    return error;
};

const userKeyFrom = (authUser) => {
    if (!authUser) return null;
    const key = authUser.identifier || authUser.session || authUser._id || authUser.id;
    return key ? String(key) : null;
};

const audit = (payload) => {
    void RpcLog.create(payload).catch((err) => {
        console.error("[RPC proxy] audit log failed", redactSecrets(err?.message || err));
    });
};

const enforceCallerLimits = async (meta) => {
    await RpcCallerModule.assertNotBanned(meta?.ip);
    await RpcCallerModule.assertWithinRateLimit(meta?.ip, { userKey: userKeyFrom(meta?.authUser) });
    RpcCallerModule.recordRequest(meta?.ip);
};

const joinUrl = (base, path) => `${String(base).replace(/\/+$/, "")}/${String(path).replace(/^\/+/, "")}`;

const forward = async (method, url, { data, headers, params, secretUrl } = {}) => {
    try {
        const client = http();
        const response = await client.request({
            url,
            method,
            data,
            params,
            headers,
            maxRedirects: 0,
            maxContentLength: UPSTREAM_RESPONSE_MAX_BYTES,
            maxBodyLength: maxBodyBytes(),
            validateStatus: (status) => status >= 200 && status < 600,
            responseType: "json",
            transitional: { silentJSONParsing: false, forcedJSONParsing: false },
        });
        if (response.status >= 300 && response.status < 400) {
            throw fail(502, "RPC upstream request failed", "rpc_upstream_failed");
        }
        const sanitized = sanitizeUpstreamBody(response.data, secretUrl || url);
        if (sanitized.leaked) {
            return {
                status: response.status >= 400 ? response.status : 502,
                body: { error: "upstream_error" },
                contentType: "application/json",
            };
        }
        const contentType = String(response.headers?.["content-type"] || "");
        const kind = /text\/plain/i.test(contentType) ? "text/plain; charset=utf-8" : "application/json";
        return { status: response.status, body: sanitized.body, contentType: kind };
    } catch (error) {
        if (error.status) throw error;
        if (isUpstreamResponseTooLarge(error)) {
            throw fail(413, "Upstream response is too large", "RESPONSE_TOO_LARGE");
        }
        throw fail(502, "RPC upstream request failed", "rpc_upstream_failed");
    }
};

const BTC_ROUTE = {
    utxo: "GET /btc/:network/address/:address/utxo",
    "blockbook-utxo": "GET /btc/:network/api/v2/utxo/:address",
    "tx-hex": "GET /btc/:network/tx/:txid/hex",
    broadcast: "POST /btc/:network/tx",
    "blockbook-send": "POST /btc/:network/api/v2/sendtx",
    "blockbook-address": "GET /btc/:network/api/v2/address/:address",
    "blockbook-tx": "GET /btc/:network/api/v2/tx/:txid",
    "blockbook-tx-specific": "GET /btc/:network/api/v2/tx-specific/:txid",
    "blockbook-block": "GET /btc/:network/api/v2/block/:blockId",
    "blockbook-block-index": "GET /btc/:network/api/v2/block-index/:blockId",
};

const STELLAR_ROUTE = {
    root: "GET /stellar",
    fee_stats: "GET /stellar/fee_stats",
    ledgers: "GET /stellar/ledgers",
    account: "GET /stellar/accounts/:accountId",
    submit: "POST /stellar/transactions",
};

const warnIfResponseTooLarge = (error, chain, route) => {
    if (error?.clientCode !== "RESPONSE_TOO_LARGE") return;
    console.warn("[RPC proxy] upstream response too large", { chain, route });
};

const readHex = (body, rawBody) => {
    if (typeof body === "string" && body.trim()) return body.trim();
    if (body && typeof body === "object" && typeof body.hex === "string") return body.hex.trim();
    if (typeof rawBody === "string" && rawBody.trim()) return rawBody.trim();
    return "";
};

const clampInt = (value, fallback, min, max) => {
    if (value == null || value === "") return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) return null;
    return n;
};

const proxyBitcoin = async ({ network, operation, address, txid, blockId, query = {}, body, rawBody, origin, authUser, ip }) => {
    if (network !== "mainnet" && network !== "testnet") {
        throw fail(404, "not_found", "not_found");
    }

    const upstream = bitcoinUpstream(network);
    if (!upstream) {
        throw fail(503, "RPC upstream is not configured", "rpc_upstream_not_configured");
    }

    await enforceCallerLimits({ authUser, ip });

    const logBase = {
        chain: network === "testnet" ? "btc-testnet" : "btc",
        chainId: network === "testnet" ? 1 : 0,
        origin: origin || "wallet",
        purpose: "extension-blockbook",
        session: authUser?.session ? String(authUser.session) : null,
        ip: ip || null,
    };
    const callUpstream = (method, url, options = {}) => forward(method, url, { ...options, secretUrl: upstream });

    try {
        let result;
        if (operation === "utxo" || operation === "blockbook-utxo") {
            if (!BTC_ADDRESS.test(String(address || ""))) throw fail(400, "invalid_address", "invalid_address");
            const params = {};
            if (query.confirmed != null && query.confirmed !== "") {
                if (query.confirmed !== "true" && query.confirmed !== "false") {
                    throw fail(400, "invalid_query", "invalid_query");
                }
                params.confirmed = query.confirmed;
            }
            result = await callUpstream("get", joinUrl(upstream, `api/v2/utxo/${address}`), { params });
        } else if (operation === "tx-hex") {
            if (!TXID.test(String(txid || ""))) throw fail(400, "invalid_txid", "invalid_txid");
            const upstreamResult = await callUpstream("get", joinUrl(upstream, `api/v2/tx/${txid}`));
            const hex = upstreamResult.body && typeof upstreamResult.body === "object" ? upstreamResult.body.hex : null;
            if (upstreamResult.status !== 200 || typeof hex !== "string" || !hex) {
                result = upstreamResult;
            } else {
                result = { status: 200, body: hex, contentType: "text/plain; charset=utf-8" };
            }
        } else if (operation === "broadcast" || operation === "blockbook-send") {
            const hex = readHex(body, rawBody);
            if (!HEX_TX.test(hex) || hex.length % 2 !== 0) throw fail(400, "invalid_raw_transaction", "invalid_raw_transaction");
            const upstreamResult = await callUpstream("post", joinUrl(upstream, "api/v2/sendtx"), {
                data: hex,
                headers: { "Content-Type": "text/plain" },
            });
            if (operation === "broadcast" && upstreamResult.status === 200) {
                if (typeof upstreamResult.body === "string" && upstreamResult.body.trim()) {
                    result = { status: 200, body: upstreamResult.body.trim(), contentType: "text/plain; charset=utf-8" };
                } else if (upstreamResult.body && typeof upstreamResult.body === "object" && upstreamResult.body.result) {
                    result = { status: 200, body: String(upstreamResult.body.result), contentType: "text/plain; charset=utf-8" };
                } else {
                    result = upstreamResult;
                }
            } else {
                result = upstreamResult;
            }
        } else if (operation === "blockbook-address") {
            if (!BTC_ADDRESS.test(String(address || ""))) throw fail(400, "invalid_address", "invalid_address");
            const params = {};
            if (query.details != null && query.details !== "") {
                const allowed = new Set(["basic", "tokens", "tokenBalances", "txids", "txs"]);
                if (!allowed.has(String(query.details))) throw fail(400, "invalid_query", "invalid_query");
                params.details = String(query.details);
            }
            const page = clampInt(query.page, undefined, 1, 50);
            if (query.page != null && query.page !== "" && page == null) throw fail(400, "invalid_query", "invalid_query");
            if (page != null) params.page = page;
            const pageSize = clampInt(query.pageSize, undefined, 1, 50);
            if (query.pageSize != null && query.pageSize !== "" && pageSize == null) throw fail(400, "invalid_query", "invalid_query");
            if (pageSize != null) params.pageSize = pageSize;
            result = await callUpstream("get", joinUrl(upstream, `api/v2/address/${address}`), { params });
        } else if (operation === "blockbook-tx" || operation === "blockbook-tx-specific") {
            if (!TXID.test(String(txid || ""))) throw fail(400, "invalid_txid", "invalid_txid");
            const suffix = operation === "blockbook-tx-specific" ? "tx-specific" : "tx";
            result = await callUpstream("get", joinUrl(upstream, `api/v2/${suffix}/${txid}`));
        } else if (operation === "blockbook-block") {
            if (!BLOCK_ID.test(String(blockId || ""))) throw fail(400, "invalid_block", "invalid_block");
            result = await callUpstream("get", joinUrl(upstream, `api/v2/block/${blockId}`));
        } else if (operation === "blockbook-block-index") {
            if (!/^\d{1,10}$/.test(String(blockId || ""))) throw fail(400, "invalid_block", "invalid_block");
            result = await callUpstream("get", joinUrl(upstream, `api/v2/block-index/${blockId}`));
        } else {
            throw fail(404, "not_found", "not_found");
        }

        audit({
            ...logBase,
            method: operation,
            success: result.status >= 200 && result.status < 300,
            httpStatus: result.status,
        });
        return result;
    } catch (error) {
        warnIfResponseTooLarge(error, logBase.chain, BTC_ROUTE[operation] || operation);
        audit({
            ...logBase,
            method: operation,
            success: false,
            httpStatus: error.status || 502,
            errorMessage: redactSecrets(error.message),
        });
        if (error.status) throw error;
        throw fail(502, "RPC upstream request failed", "rpc_upstream_failed");
    }
};

const proxyStellar = async ({ operation, accountId, query = {}, body, origin, authUser, ip }) => {
    const upstream = stellarUpstream();
    if (!upstream) {
        throw fail(503, "RPC upstream is not configured", "rpc_upstream_not_configured");
    }

    await enforceCallerLimits({ authUser, ip });

    const logBase = {
        chain: "stellar",
        chainId: 150,
        origin: origin || "wallet",
        purpose: "extension-horizon",
        session: authUser?.session ? String(authUser.session) : null,
        ip: ip || null,
    };
    const callUpstream = (method, url, options = {}) => forward(method, url, { ...options, secretUrl: upstream });

    try {
        let result;
        if (operation === "root") {
            result = await callUpstream("get", String(upstream).replace(/\/+$/, ""));
        } else if (operation === "fee_stats") {
            result = await callUpstream("get", joinUrl(upstream, "fee_stats"));
        } else if (operation === "ledgers") {
            const params = {};
            if (query.order != null && query.order !== "") {
                if (query.order !== "asc" && query.order !== "desc") throw fail(400, "invalid_query", "invalid_query");
                params.order = query.order;
            }
            if (query.limit != null && query.limit !== "") {
                const limit = clampInt(query.limit, null, 1, 20);
                if (limit == null) throw fail(400, "invalid_query", "invalid_query");
                params.limit = limit;
            }
            if (query.cursor != null && query.cursor !== "") {
                if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(query.cursor))) throw fail(400, "invalid_query", "invalid_query");
                params.cursor = String(query.cursor);
            }
            result = await callUpstream("get", joinUrl(upstream, "ledgers"), { params });
        } else if (operation === "account") {
            if (!STELLAR_ACCOUNT.test(String(accountId || ""))) throw fail(400, "invalid_account", "invalid_account");
            result = await callUpstream("get", joinUrl(upstream, `accounts/${accountId}`));
        } else if (operation === "submit") {
            const tx = body && typeof body === "object" ? body.tx : typeof body === "string" ? body : "";
            if (!STELLAR_XDR.test(String(tx || ""))) throw fail(400, "invalid_transaction", "invalid_transaction");
            const encoded = new URLSearchParams({ tx: String(tx) }).toString();
            result = await callUpstream("post", joinUrl(upstream, "transactions"), {
                data: encoded,
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
            });
        } else {
            throw fail(404, "not_found", "not_found");
        }

        audit({
            ...logBase,
            method: operation,
            success: result.status >= 200 && result.status < 300,
            httpStatus: result.status,
        });
        return result;
    } catch (error) {
        warnIfResponseTooLarge(error, logBase.chain, STELLAR_ROUTE[operation] || operation);
        audit({
            ...logBase,
            method: operation,
            success: false,
            httpStatus: error.status || 502,
            errorMessage: redactSecrets(error.message),
        });
        if (error.status) throw error;
        throw fail(502, "RPC upstream request failed", "rpc_upstream_failed");
    }
};

module.exports = {
    proxyBitcoin,
    proxyStellar,
};
