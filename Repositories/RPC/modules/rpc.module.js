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
} = require("../../../Core/rpc-upstreams");

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

module.exports = {
    forwardRequest,
    getChains,
    getExtensionChains,
};
