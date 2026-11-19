const RpcCallerModule = require("../../RPCCaller/modules/rpc-caller.module");
const { maxBodyBytes, redactSecrets } = require("../../../Core/rpc-upstreams");
const { decideSessionless } = require("../modules/sessionless-lane.module");
const { forwardSessionlessCall } = require("../modules/rpc.module");

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

const laneCode = (error) => {
    const code = String(error?.clientCode || "");
    if (/^[A-Z0-9_]+$/.test(code)) return code;
    if (code === "rpc_caller_banned") return "RPC_CALLER_BANNED";
    return "RPC_UPSTREAM_FAILED";
};

const reject = (ctx, status, code, message) => {
    ctx.status = status;
    ctx.body = { error: code, message };
};

/**
 * POST /api/rpc/:chainKey on the unprotected router.
 * A session header, or a disabled lane, falls through to JWT and the protected route.
 * Otherwise the request is answered here or rejected with an UPPER_SNAKE code.
 */
const sessionlessAppLane = async (ctx, next) => {
    const decision = decideSessionless(ctx);
    if (decision.action === "pass") {
        await next();
        return;
    }

    if (decision.action === "reject") {
        reject(ctx, decision.status, decision.code, decision.message);
        return;
    }

    const max = maxBodyBytes();
    const headerLen = Number(ctx.get("content-length") || 0);
    if ((Number.isFinite(headerLen) && headerLen > max) || measuredBodyBytes(ctx.request.body) > max) {
        reject(ctx, 413, "RPC_SESSIONLESS_BODY_TOO_LARGE", "Request too large.");
        return;
    }

    const ip = String(ctx.ip || "").trim();
    if (!ip) {
        reject(ctx, 400, "RPC_SESSIONLESS_IP_REQUIRED", "Client address is required.");
        return;
    }

    try {
        await RpcCallerModule.assertNotBanned(ip);
        await RpcCallerModule.assertWithinSessionlessRateLimit(ip, decision.calls.length);
    } catch (error) {
        if (error.status === 429 && error.retryAfterSeconds != null) {
            ctx.set("Retry-After", String(error.retryAfterSeconds));
        }
        reject(ctx, error.status || 429, laneCode(error), redactSecrets(error.message || "RPC rate limit exceeded"));
        return;
    }

    const userAgent = String(ctx.get("user-agent") || "").slice(0, 200);
    console.info("[RPC sessionless]", {
        chain: decision.chain,
        methods: decision.calls.map((call) => call.method),
        count: decision.calls.length,
        userAgent,
    });

    const responses = [];
    let singleFailureStatus = 502;
    for (const call of decision.calls) {
        RpcCallerModule.recordRequest(ip);
        try {
            const data = await forwardSessionlessCall(
                {
                    chain: decision.chain,
                    method: call.method,
                    params: call.params,
                    rpcId: call.id,
                    ip,
                },
                { skipRateLimit: true }
            );
            responses.push({
                jsonrpc: "2.0",
                id: call.id,
                result: data.result,
            });
        } catch (error) {
            singleFailureStatus = error.status || 502;
            responses.push({
                jsonrpc: "2.0",
                id: call.id,
                error: {
                    code: error.status === 403 ? -32601 : error.status === 429 ? -32005 : -32603,
                    message: redactSecrets(error.message || "RPC upstream request failed"),
                    data: { clientCode: laneCode(error) },
                },
            });
        }
    }

    if (!decision.batch && responses.length === 1 && responses[0].error) {
        const code = responses[0].error.data.clientCode;
        // A node answered with a JSON-RPC error (revert, nonce, and similar).
        // Keep the JSON-RPC body on HTTP 200 so wallets can read that message.
        if (code === "RPC_UPSTREAM_ERROR") {
            ctx.status = 200;
            ctx.body = responses[0];
            return;
        }
        reject(ctx, singleFailureStatus, code, responses[0].error.message);
        return;
    }

    ctx.status = 200;
    ctx.body = decision.batch ? responses : responses[0];
};

module.exports = {
    sessionlessAppLane,
};
