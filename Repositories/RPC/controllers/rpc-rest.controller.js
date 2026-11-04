const Rest = require("../modules/rpc-rest.module");
const { redactSecrets } = require("../../../Core/rpc-upstreams");

const rawBodyOf = (ctx) => {
    const raw = ctx.request.rawBody ?? ctx.request.body?.[Symbol.for("unparsedBody")];
    if (typeof raw === "string") return raw;
    if (Buffer.isBuffer(raw)) return raw.toString("utf8");
    return "";
};

const sendResult = (ctx, result) => {
    ctx.status = result.status || 200;
    if (result.contentType) ctx.set("Content-Type", result.contentType);
    ctx.body = result.body;
};

const sendError = (ctx, error) => {
    const status = error.status || 502;
    if (status === 429 && error.retryAfterSeconds != null) {
        ctx.set("Retry-After", String(error.retryAfterSeconds));
    }
    ctx.status = status;
    ctx.body = {
        error: redactSecrets(error.message || "RPC upstream request failed"),
        ...(error.clientCode ? { clientCode: error.clientCode } : {}),
    };
};

const bitcoin = (operation) => async (ctx) => {
    try {
        const result = await Rest.proxyBitcoin({
            network: ctx.params.network,
            operation,
            address: ctx.params.address,
            txid: ctx.params.txid,
            blockId: ctx.params.blockId,
            query: ctx.query || {},
            body: ctx.request.body,
            rawBody: rawBodyOf(ctx),
            origin: ctx.get("origin") || undefined,
            authUser: ctx.state.user,
            ip: ctx.ip,
        });
        sendResult(ctx, result);
    } catch (error) {
        sendError(ctx, error);
    }
};

const stellar = (operation) => async (ctx) => {
    try {
        const result = await Rest.proxyStellar({
            operation,
            accountId: ctx.params.accountId,
            query: ctx.query || {},
            body: ctx.request.body,
            origin: ctx.get("origin") || undefined,
            authUser: ctx.state.user,
            ip: ctx.ip,
        });
        sendResult(ctx, result);
    } catch (error) {
        sendError(ctx, error);
    }
};

module.exports = {
    bitcoin,
    stellar,
};
