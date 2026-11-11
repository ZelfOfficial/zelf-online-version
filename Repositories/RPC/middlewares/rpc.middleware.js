const { array, any, jsonRpcParams, string, stringOrNumber, validate } = require("../../../Core/JoiUtils");
const config = require("../../../Core/config");
const { rejectIfUnsupportedChain } = require("../../../Core/unsupported-networks");
const { maxBatch, maxBodyBytes } = require("../../../Core/rpc-upstreams");

const RESERVED_CHAIN_PATH = new Set(["chains", "request"]);

const schemas = {
    request: {
        chain: string(),
        chainId: stringOrNumber(),
        method: string().required(),
        origin: string(),
        params: array(),
        purpose: string(),
        rpcId: stringOrNumber(),
    },
    /** Standard JSON-RPC 2.0 body (chain comes from URL path). */
    jsonRpc: {
        jsonrpc: string().valid("2.0").optional(),
        method: string().required(),
        params: jsonRpcParams(),
        id: any().optional(),
    },
};

const ensureConfig = (ctx) => {
    if (!config.rpc?.chains || !Object.keys(config.rpc.chains).length) {
        ctx.status = 501;
        ctx.body = { error: "service_unavailable" };
        return false;
    }

    return true;
};

const requestValidation = async (ctx, next) => {
    if (!ensureConfig(ctx)) {
        return;
    }

    const valid = validate(schemas.request, ctx.request.body, ["chain", "chainId"]);
    if (valid.error) {
        ctx.status = 400;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    ctx.request.body = valid.value;
    await next();
};

/**
 * Validate a JSON-RPC body that may be either a single object or a batch array
 * (ethers v6 `JsonRpcProvider` sends arrays). On batch validation, sets
 * `ctx.state.rpcBatch` to an array of `{ value, error, originalId }` so the
 * controller can produce per-item responses; on single-object input, replaces
 * `ctx.request.body` with the validated value (existing behavior).
 */
const measuredBodyBytes = (body) => {
    if (body == null || body === "") return 0;
    if (typeof body === "string") return Buffer.byteLength(body);
    if (Buffer.isBuffer(body)) return body.length;
    try {
        return Buffer.byteLength(JSON.stringify(body));
    } catch {
        return Number.MAX_SAFE_INTEGER;
    }
};

const tooLargeBody = (ctx, asJsonRpc) => {
    ctx.status = 413;
    ctx.body = asJsonRpc
        ? {
              jsonrpc: "2.0",
              id: ctx.request.body?.id ?? null,
              error: { code: -32600, message: "Request too large" },
          }
        : { error: "rpc_body_too_large" };
};

/**
 * Reject oversized RPC bodies. The global koa-body limit is much higher (uploads);
 * this cap applies only to RPC routes.
 */
const assertRpcBodyLimit = (asJsonRpc = false) => async (ctx, next) => {
    const max = maxBodyBytes();
    const headerLen = Number(ctx.get("content-length") || 0);
    if ((Number.isFinite(headerLen) && headerLen > max) || measuredBodyBytes(ctx.request.body) > max) {
        tooLargeBody(ctx, asJsonRpc);
        return;
    }
    await next();
};

const validateJsonRpcBody = (ctx) => {
    const body = ctx.request.body;

    if (Array.isArray(body)) {
        if (body.length > maxBatch()) {
            tooLargeBody(ctx, true);
            return false;
        }
        if (!body.length) {
            ctx.status = 200;
            ctx.body = {
                jsonrpc: "2.0",
                id: null,
                error: { code: -32600, message: "Invalid Request: empty batch" },
            };
            return false;
        }

        ctx.state.rpcBatch = body.map((item) => {
            const valid = validate(schemas.jsonRpc, item || {});
            return {
                value: valid.value,
                error: valid.error,
                originalId: item && item.id !== undefined ? item.id : null,
            };
        });

        return true;
    }

    const valid = validate(schemas.jsonRpc, body || {});
    if (valid.error) {
        ctx.status = 200;
        ctx.body = {
            jsonrpc: "2.0",
            id: body?.id ?? null,
            error: { code: -32600, message: valid.error.message.trim() },
        };
        return false;
    }

    ctx.request.body = valid.value;
    return true;
};

/** JWT extension proxy: uses config.extension.rpc.chains (same JSON-RPC body as public /api/rpc/:chainKey). */
const jsonRpcValidationExtension = async (ctx, next) => {
    if (rejectIfUnsupportedChain(ctx, ctx.params?.chainKey)) return;
    if (measuredBodyBytes(ctx.request.body) > maxBodyBytes() || Number(ctx.get("content-length") || 0) > maxBodyBytes()) {
        tooLargeBody(ctx, true);
        return;
    }
    if (!config.extension?.rpc?.chains || !Object.keys(config.extension.rpc.chains).length) {
        ctx.status = 200;
        ctx.body = {
            jsonrpc: "2.0",
            id: ctx.request.body?.id ?? null,
            error: { code: -32603, message: "Extension RPC service unavailable" },
        };
        return;
    }

    const { chainKey } = ctx.params;
    if (!chainKey || RESERVED_CHAIN_PATH.has(String(chainKey).toLowerCase())) {
        ctx.status = 404;
        ctx.body = { error: "not_found" };
        return;
    }

    if (!validateJsonRpcBody(ctx)) {
        return;
    }

    await next();
};

const jsonRpcValidation = async (ctx, next) => {
    if (rejectIfUnsupportedChain(ctx, ctx.params?.chainKey)) return;
    if (measuredBodyBytes(ctx.request.body) > maxBodyBytes() || Number(ctx.get("content-length") || 0) > maxBodyBytes()) {
        tooLargeBody(ctx, true);
        return;
    }
    if (!config.rpc?.chains || !Object.keys(config.rpc.chains).length) {
        ctx.status = 200;
        ctx.body = {
            jsonrpc: "2.0",
            id: ctx.request.body?.id ?? null,
            error: { code: -32603, message: "RPC service unavailable" },
        };
        return;
    }

    const { chainKey } = ctx.params;
    if (!chainKey || RESERVED_CHAIN_PATH.has(String(chainKey).toLowerCase())) {
        ctx.status = 404;
        ctx.body = { error: "not_found" };
        return;
    }

    if (!validateJsonRpcBody(ctx)) {
        return;
    }

    await next();
};

module.exports = {
    requestValidation,
    jsonRpcValidation,
    jsonRpcValidationExtension,
    assertRpcBodyLimit,
};
