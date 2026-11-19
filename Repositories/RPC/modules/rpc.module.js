const config = require("../../../Core/config");
const { getCleanInstance } = require("../../../Core/axios");
const RpcLog = require("../models/rpc-log.model");
const RpcCallerModule = require("../../RPCCaller/modules/rpc-caller.module");
const { translateSuiJsonRpc } = require("../../sui/modules/sui-jsonrpc.module");
const {
    UPSTREAM_RESPONSE_MAX_BYTES,
    bodyContainsUpstreamSecret,
    extensionChains,
    isUpstreamResponseTooLarge,
    legacyChains,
    maxBodyBytes,
    methodsForKind,
    redactSecrets,
    sessionlessUpstreamPlan,
} = require("../../../Core/rpc-upstreams");
const { canonicalSessionlessMethod, inspectLogFilter, SESSIONLESS_CHAINS } = require("./sessionless-lane.module");

const instance = getCleanInstance(config.rpc?.timeoutMs || 15000);

const CHAIN_ALIASES = {
    sepolia: "ethereum-sepolia",
};

const truncateMessage = (message, maxLen = 500) => {
    if (message == null || message === "") return null;
    return redactSecrets(message).slice(0, maxLen);
};

const persistRpcAudit = (payload) => {
    void RpcLog.create(payload).catch((err) => {
        console.error("[RPC proxy] audit log failed", redactSecrets(err?.message || err));
    });
};

const buildChainMaps = (chainsObj) => {
    const chainEntries = Object.entries(chainsObj || {});
    const chainsByKey = new Map(
        chainEntries.map(([key, value]) => [
            key.toLowerCase(),
            {
                key,
                chainId: Number(value.chainId),
                rpcUrl: value.rpcUrl,
                kind: value.kind,
                requireUpstream: Boolean(value.requireUpstream),
            },
        ])
    );
    const chainsById = new Map(chainEntries.map(([key, value]) => [Number(value.chainId), chainsByKey.get(key.toLowerCase())]));
    return { chainsByKey, chainsById };
};

const blockedMethodSet = () => new Set((config.rpc?.blockedMethods || []).map((method) => String(method).toLowerCase()));
const blockedPrefixList = () => (config.rpc?.blockedMethodPrefixes || []).map((prefix) => String(prefix).toLowerCase());
const allowedMethodSet = () => new Set((config.rpc?.allowedMethods || []).map((method) => String(method).toLowerCase()));

const getChains = () =>
    Array.from(buildChainMaps(legacyChains()).chainsByKey.values()).map((chain) => ({
        chain: chain.key,
        chainId: chain.chainId,
        rpcConfigured: Boolean(chain.rpcUrl),
    }));

const getExtensionChains = () =>
    Array.from(buildChainMaps(extensionChains()).chainsByKey.values()).map((chain) => ({
        chain: chain.key,
        chainId: chain.chainId,
        rpcConfigured: Boolean(chain.rpcUrl),
    }));

const resolveChain = ({ chain, chainId }, maps) => {
    if (chain) {
        const raw = String(chain).trim().toLowerCase();
        const key = CHAIN_ALIASES[raw] || raw;
        return maps.chainsByKey.get(key) || null;
    }

    if (chainId !== undefined && chainId !== null && chainId !== "") {
        return maps.chainsById.get(Number(chainId)) || null;
    }

    return null;
};

const fail = (status, message, clientCode) => {
    const error = new Error(message);
    error.status = status;
    if (clientCode) error.clientCode = clientCode;
    return error;
};

const ensureMethodAllowed = (method, kind) => {
    const normalized = String(method || "").trim().toLowerCase();

    if (!normalized || normalized.length > 64) {
        throw fail(400, "Missing RPC method", "rpc_method_invalid");
    }

    const prefixes = blockedPrefixList();
    const isBlocked =
        blockedMethodSet().has(normalized) ||
        prefixes.some((prefix) => normalized.startsWith(prefix)) ||
        normalized.includes("subscribe");
    if (isBlocked) {
        throw fail(403, "RPC method is not allowed", "rpc_method_not_allowed");
    }

    const globalAllowed = allowedMethodSet();
    if (globalAllowed.size && !globalAllowed.has(normalized)) {
        throw fail(403, "RPC method is not allowed", "rpc_method_not_allowed");
    }

    const chainMethods = methodsForKind(kind);
    if (!chainMethods.some((name) => String(name).toLowerCase() === normalized)) {
        throw fail(403, "RPC method is not allowed", "rpc_method_not_allowed");
    }

    return normalized;
};

const resolveUpstreamMethodName = (normalized, originalMethod, kind) => {
    const fromChain = methodsForKind(kind).find((name) => String(name).toLowerCase() === normalized);
    if (fromChain) return String(fromChain);
    const fromConfig = (config.rpc?.allowedMethods || []).find((name) => String(name).toLowerCase() === normalized);
    if (fromConfig) return String(fromConfig);
    const raw = String(originalMethod ?? "").trim();
    if (raw && raw.toLowerCase() === normalized) return raw;
    return normalized;
};

const userKeyFrom = (authUser) => {
    if (!authUser) return null;
    const key = authUser.identifier || authUser.session || authUser._id || authUser.id;
    return key ? String(key) : null;
};

const forwardRequest = async ({ chain, chainId, method, params = [], origin, purpose, rpcId }, meta = {}, options = {}) => {
    const { isUnsupportedChain } = require("../../../Core/unsupported-networks");
    if (isUnsupportedChain(chain) || isUnsupportedChain(chainId)) {
        throw fail(400, "UNSUPPORTED_CHAIN", "UNSUPPORTED_CHAIN");
    }
    const maps = buildChainMaps(options.useExtensionRpc ? extensionChains() : legacyChains());
    const resolvedChain = resolveChain({ chain, chainId }, maps);

    if (!resolvedChain) {
        throw fail(400, "Unsupported RPC chain", "rpc_chain_unsupported");
    }

    if (!resolvedChain.rpcUrl) {
        throw fail(503, "RPC upstream is not configured", "rpc_upstream_not_configured");
    }

    const normalizedMethod = ensureMethodAllowed(method, resolvedChain.kind);
    const upstreamMethod = resolveUpstreamMethodName(normalizedMethod, method, resolvedChain.kind);

    const normalizedParams = params == null ? [] : Array.isArray(params) || (typeof params === "object" && params !== null) ? params : [];

    const paramSlotCount = Array.isArray(normalizedParams)
        ? normalizedParams.length
        : typeof normalizedParams === "object" && normalizedParams !== null
          ? Object.keys(normalizedParams).length
          : 0;

    if (paramSlotCount > (config.rpc?.maxParamsLength || 25)) {
        throw fail(400, "Too many RPC params", "rpc_params_too_large");
    }

    const encodedParams = JSON.stringify(normalizedParams);
    if (Buffer.byteLength(encodedParams) > maxBodyBytes()) {
        throw fail(413, "Request too large", "rpc_body_too_large");
    }

    const logContext = {
        chain: resolvedChain.key,
        chainId: resolvedChain.chainId,
        method: normalizedMethod,
        origin: origin || "wallet",
        purpose: purpose || (options.useExtensionRpc ? "extension-json-rpc" : "json-rpc"),
        session: meta?.authUser?.session ? String(meta.authUser.session) : null,
        ip: meta?.ip || null,
    };

    await RpcCallerModule.assertNotBanned(meta?.ip);
    await RpcCallerModule.assertWithinRateLimit(meta?.ip, { userKey: userKeyFrom(meta?.authUser) });
    RpcCallerModule.recordRequest(meta?.ip);

    if (process.env.NODE_ENV !== "production") {
        console.info("[RPC proxy request]", logContext, options.useExtensionRpc ? { extensionRpc: true } : {});
    }

    try {
        if (resolvedChain.key === "sui") {
            const result = await translateSuiJsonRpc(upstreamMethod, normalizedParams);
            persistRpcAudit({
                ...logContext,
                success: true,
                httpStatus: 200,
            });
            return {
                chain: resolvedChain.key,
                chainId: resolvedChain.chainId,
                method: upstreamMethod,
                result: result ?? null,
                upstreamId: rpcId ?? 1,
            };
        }

        const { data } = await instance.post(
            resolvedChain.rpcUrl,
            {
                jsonrpc: "2.0",
                id: rpcId ?? 1,
                method: upstreamMethod,
                params: normalizedParams,
            },
            {
                headers: { "Content-Type": "application/json" },
                maxRedirects: 0,
                maxBodyLength: maxBodyBytes(),
                maxContentLength: UPSTREAM_RESPONSE_MAX_BYTES,
            }
        );

        if (bodyContainsUpstreamSecret(data, resolvedChain.rpcUrl)) {
            throw fail(502, "RPC upstream request failed", "rpc_upstream_failed");
        }

        if (data?.error) {
            const error = fail(502, redactSecrets(data.error.message || "RPC upstream error"), "rpc_upstream_error");
            const details = data.error.data;
            if (details != null && !bodyContainsUpstreamSecret(details, resolvedChain.rpcUrl)) {
                error.details = typeof details === "string" ? redactSecrets(details) : details;
            }
            throw error;
        }

        persistRpcAudit({
            ...logContext,
            success: true,
            httpStatus: 200,
        });

        return {
            chain: resolvedChain.key,
            chainId: resolvedChain.chainId,
            method: upstreamMethod,
            result: data?.result ?? null,
            upstreamId: data?.id ?? rpcId ?? 1,
        };
    } catch (error) {
        if (!error.status && isUpstreamResponseTooLarge(error)) {
            console.warn("[RPC proxy] upstream response too large", {
                chain: resolvedChain.key,
                route: upstreamMethod,
            });
            error = fail(413, "Upstream response is too large", "RESPONSE_TOO_LARGE");
        }
        const status = error.status || 502;
        persistRpcAudit({
            ...logContext,
            success: false,
            httpStatus: status,
            errorMessage: truncateMessage(error?.message),
        });

        if (error.status) {
            error.message = redactSecrets(error.message);
            throw error;
        }

        throw fail(502, "RPC upstream request failed", "rpc_upstream_failed");
    }
};

const jsonRpcUnavailable = (data) => {
    if (!data?.error) return false;
    const code = data.error.code;
    if (code === -32005 || code === -32016) return true;
    return /rate limit|too many requests|temporarily unavailable|service unavailable|timeout exceeded/i.test(String(data.error.message || ""));
};

const postJsonRpc = async (url, body) => {
    const { data } = await instance.post(url, body, {
        headers: { "Content-Type": "application/json" },
        maxRedirects: 0,
        maxBodyLength: maxBodyBytes(),
        maxContentLength: UPSTREAM_RESPONSE_MAX_BYTES,
    });
    return data;
};

const classifyUpstream = (data, url) => {
    if (bodyContainsUpstreamSecret(data, url)) return { leak: true };
    if (jsonRpcUnavailable(data)) return { unavailable: true };
    if (data?.error) return { rpcError: data.error, id: data.id };
    return { ok: true, result: data?.result ?? null, id: data?.id };
};

const attemptUpstream = async (url, payload) => {
    try {
        const data = await postJsonRpc(url, payload);
        return classifyUpstream(data, url);
    } catch (error) {
        if (isUpstreamResponseTooLarge(error)) return { tooLarge: true };
        const status = Number(error?.response?.status);
        const data = error?.response?.data;
        const answered = data && typeof data === "object" && data.error && status >= 400 && status < 500 && ![401, 402, 403, 408, 429].includes(status);
        if (answered) return classifyUpstream(data, url);
        const transport = !error?.response || status === 401 || status === 402 || status === 403 || status === 408 || status === 429 || status >= 500;
        if (transport) return { unavailable: true };
        return { failed: true };
    }
};

/**
 * One JSON-RPC call on the compatibility lane.
 * Reads go to the public endpoint first. eth_sendRawTransaction and eth_estimateGas
 * use the paid URL first. A transport failure or an unavailable public node tries the other URL once.
 * The caller reserves the rate-limit budget (`skipRateLimit`) when a batch is counted up front.
 */
const forwardSessionlessCall = async ({ chain, method, params = [], rpcId, ip }, options = {}) => {
    const chainKey = String(chain || "").trim().toLowerCase();
    if (!SESSIONLESS_CHAINS.has(chainKey)) {
        throw fail(400, "This compatibility lane allows ethereum, avalanche, polygon, and bsc.", "RPC_SESSIONLESS_CHAIN_NOT_ALLOWED");
    }

    const canonical = canonicalSessionlessMethod(method);
    if (!canonical) {
        throw fail(403, "RPC method is not available on the compatibility lane.", "RPC_SESSIONLESS_METHOD_NOT_ALLOWED");
    }

    const normalizedParams = params == null ? [] : Array.isArray(params) || (typeof params === "object" && params !== null) ? params : [];
    if (canonical === "eth_getLogs") {
        const problem = inspectLogFilter(normalizedParams);
        if (problem) throw fail(400, problem.message, problem.code);
    }

    const paramSlotCount = Array.isArray(normalizedParams)
        ? normalizedParams.length
        : typeof normalizedParams === "object" && normalizedParams !== null
          ? Object.keys(normalizedParams).length
          : 0;
    if (paramSlotCount > (config.rpc?.maxParamsLength || 25)) {
        throw fail(400, "Too many RPC params", "RPC_PARAMS_TOO_LARGE");
    }

    const encodedParams = JSON.stringify(normalizedParams);
    if (Buffer.byteLength(encodedParams) > maxBodyBytes()) {
        throw fail(413, "Request too large", "RPC_BODY_TOO_LARGE");
    }

    if (!options.skipRateLimit) {
        await RpcCallerModule.assertNotBanned(ip);
        await RpcCallerModule.assertWithinSessionlessRateLimit(ip, 1);
        RpcCallerModule.recordRequest(ip);
    }

    const plan = sessionlessUpstreamPlan(chainKey, canonical);
    if (!plan.primary) {
        throw fail(503, "RPC upstream is not configured", "RPC_UPSTREAM_NOT_CONFIGURED");
    }

    const payload = {
        jsonrpc: "2.0",
        id: rpcId ?? 1,
        method: canonical,
        params: normalizedParams,
    };

    const logContext = {
        chain: chainKey,
        method: canonical,
        origin: "native-app",
        purpose: "sessionless-json-rpc",
        ip: ip || null,
    };

    let outcome = await attemptUpstream(plan.primary, payload);
    if ((outcome.unavailable || outcome.failed) && plan.fallback) {
        outcome = await attemptUpstream(plan.fallback, payload);
    }

    if (outcome.tooLarge) {
        console.warn("[RPC proxy] upstream response too large", { chain: chainKey, route: canonical });
        const error = fail(413, "Upstream response is too large", "RESPONSE_TOO_LARGE");
        persistRpcAudit({ ...logContext, success: false, httpStatus: 413, errorMessage: error.message });
        throw error;
    }

    if (outcome.leak || outcome.unavailable || outcome.failed || (outcome.ok == null && !outcome.rpcError)) {
        const error = fail(502, "RPC upstream request failed", "RPC_UPSTREAM_FAILED");
        persistRpcAudit({ ...logContext, success: false, httpStatus: 502, errorMessage: error.message });
        throw error;
    }

    if (outcome.rpcError) {
        const error = fail(502, redactSecrets(outcome.rpcError.message || "RPC upstream error"), "RPC_UPSTREAM_ERROR");
        const details = outcome.rpcError.data;
        if (details != null && !bodyContainsUpstreamSecret(details, plan.primary) && !bodyContainsUpstreamSecret(details, plan.fallback)) {
            error.details = typeof details === "string" ? redactSecrets(details) : details;
        }
        persistRpcAudit({ ...logContext, success: false, httpStatus: 502, errorMessage: truncateMessage(error.message) });
        throw error;
    }

    persistRpcAudit({ ...logContext, success: true, httpStatus: 200 });

    return {
        chain: chainKey,
        method: canonical,
        result: outcome.result,
        upstreamId: outcome.id ?? rpcId ?? 1,
    };
};

module.exports = {
    forwardRequest,
    forwardSessionlessCall,
    getChains,
    getExtensionChains,
};
