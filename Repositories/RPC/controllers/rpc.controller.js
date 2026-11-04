const Module = require("../modules/rpc.module");

const jsonRpcErrorBody = (id, status, error) => {
    let code = -32603;
    let message = error?.message || "Internal error";
    let data = error?.details;

    if (status === 400 || status === 413) {
        code = status === 413 ? -32600 : -32602;
    } else if (status === 403) {
        code = -32601;
    } else if (status === 429) {
        code = -32005;
    } else if (status === 502 || status === 503) {
        code = -32603;
    }

    if (error?.clientCode) {
        data = data == null ? { clientCode: error.clientCode } : { details: data, clientCode: error.clientCode };
    }

    return {
        jsonrpc: "2.0",
        id: id !== undefined ? id : null,
        error: {
            code,
            message,
            ...(data != null ? { data } : {}),
        },
    };
};

const getChains = async (ctx) => {
    try {
        const data = Module.getChains();
        ctx.body = { data };
    } catch (error) {
        ctx.status = error.status || 500;
        ctx.body = { error: error.message };
    }
};

const getExtensionChains = async (ctx) => {
    try {
        const data = Module.getExtensionChains();
        ctx.body = { data };
    } catch (error) {
        ctx.status = error.status || 500;
        ctx.body = { error: error.message };
    }
};

const request = async (ctx) => {
    try {
        const data = await Module.forwardRequest(ctx.request.body, {
            authUser: ctx.state.user,
            ip: ctx.ip,
        });

        ctx.body = { data };
    } catch (error) {
        ctx.status = error.status || 500;
        if (error.status === 429 && error.retryAfterSeconds != null) {
            ctx.set("Retry-After", String(error.retryAfterSeconds));
        }
        ctx.body = {
            error: error.message,
            ...(error.clientCode ? { clientCode: error.clientCode } : {}),
            ...(error.details ? { details: error.details } : {}),
        };
    }
};

/** Forward a single validated JSON-RPC request and return its `{jsonrpc, id, result|error}` envelope. */
const handleSingleJsonRpc = async (ctx, body, chainKey, options, purpose) => {
    const rpcId = body.id;

    try {
        const data = await Module.forwardRequest(
            {
                chain: chainKey,
                method: body.method,
                params: body.params ?? [],
                rpcId,
                origin: ctx.get("origin") || undefined,
                purpose,
            },
            {
                authUser: ctx.state.user,
                ip: ctx.ip,
            },
            options
        );

        return {
            ok: true,
            response: {
                jsonrpc: "2.0",
                id: rpcId !== undefined ? rpcId : null,
                result: data.result,
            },
        };
    } catch (error) {
        const status = error.status || 500;
        return {
            ok: false,
            status,
            retryAfterSeconds: error.retryAfterSeconds,
            response: jsonRpcErrorBody(rpcId, status, error),
        };
    }
};

/**
 * Run a JSON-RPC batch produced by `validateJsonRpcBody` (each entry is
 * `{ value, error, originalId }`) and respond with an array of result/error
 * envelopes — required for ethers v6 `JsonRpcProvider`, which sends batches.
 */
const handleJsonRpcBatch = async (ctx, chainKey, options, purpose) => {
    const batch = ctx.state.rpcBatch || [];

    let earliestRetryAfter = null;

    const responses = await Promise.all(
        batch.map(async (item) => {
            if (item.error) {
                return {
                    jsonrpc: "2.0",
                    id: item.originalId,
                    error: { code: -32600, message: item.error.message.trim() },
                };
            }

            const outcome = await handleSingleJsonRpc(ctx, item.value, chainKey, options, purpose);
            if (!outcome.ok && outcome.status === 429 && outcome.retryAfterSeconds != null) {
                if (earliestRetryAfter == null || outcome.retryAfterSeconds < earliestRetryAfter) {
                    earliestRetryAfter = outcome.retryAfterSeconds;
                }
            }
            return outcome.response;
        })
    );

    if (earliestRetryAfter != null) {
        ctx.set("Retry-After", String(earliestRetryAfter));
    }

    ctx.status = 200;
    ctx.body = responses;
};

/**
 * Drop-in JSON-RPC 2.0: POST /api/rpc/:chain with body
 * `{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}` — chain is taken from the path only.
 * Also accepts a JSON-RPC 2.0 batch (array of request objects) and replies with an array of responses.
 */
const requestJsonRpc = async (ctx) => {
    const chainKey = ctx.params.chainKey;

    if (ctx.state.rpcBatch) {
        await handleJsonRpcBatch(ctx, chainKey, {}, "json-rpc");
        return;
    }

    const outcome = await handleSingleJsonRpc(ctx, ctx.request.body, chainKey, {}, "json-rpc");
    if (!outcome.ok && outcome.status === 429 && outcome.retryAfterSeconds != null) {
        ctx.set("Retry-After", String(outcome.retryAfterSeconds));
    }
    ctx.status = 200;
    ctx.body = outcome.response;
};

/** POST /api/protected/rpc/:chainKey — same JSON-RPC proxy as public route, but uses extension RPC URLs and requires JWT. */
const requestExtensionJsonRpc = async (ctx) => {
    const chainKey = ctx.params.chainKey;
    const options = { useExtensionRpc: true };

    if (ctx.state.rpcBatch) {
        await handleJsonRpcBatch(ctx, chainKey, options, "extension-json-rpc");
        return;
    }

    const outcome = await handleSingleJsonRpc(ctx, ctx.request.body, chainKey, options, "extension-json-rpc");
    if (!outcome.ok && outcome.status === 429 && outcome.retryAfterSeconds != null) {
        ctx.set("Retry-After", String(outcome.retryAfterSeconds));
    }
    ctx.status = 200;
    ctx.body = outcome.response;
};

module.exports = {
    getChains,
    getExtensionChains,
    request,
    requestJsonRpc,
    requestExtensionJsonRpc,
};
