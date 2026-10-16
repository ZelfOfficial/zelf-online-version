const { PassThrough } = require("stream");
const Module = require("../modules/zai-identity.module");
const ChatModule = require("../modules/zai-chat.module");
const AngelaModule = require("../modules/zai-angela.module");
const { errorHandler } = require("../../../Core/http-handler");

/**
 * Exchange an identity token (from decrypt) for a short-lived zAI token
 * @param {Object} ctx - Koa context
 */
const createSession = async (ctx) => {
    try {
        const data = await Module.exchangeForZaiToken(ctx.request.body.identityToken);

        ctx.body = { data };
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;

        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

/**
 * Lock / logout: revoke the identity token and every zAI token derived from it
 * @param {Object} ctx - Koa context
 */
const revokeIdentity = async (ctx) => {
    try {
        const data = await Module.revokeIdentityToken(ctx.request.body.identityToken);

        ctx.body = { data };
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;

        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

/**
 * Current zAI identity (zAI token only)
 * @param {Object} ctx - Koa context
 */
const getMe = async (ctx) => {
    try {
        const data = Module.getZaiIdentity(ctx.state.zai);

        ctx.body = { data };
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;

        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

const STREAM_TIMEOUT_MS = AngelaModule.WAIT_TIMEOUT_MS + 10 * 1000; // hard stop; ZAI_TIMEOUT is sent at ~150 s
const PING_MS = 15 * 1000;

/**
 * zAI chat turn, streamed as SSE (meta, delta, card, done, error)
 * @param {Object} ctx - Koa context
 */
const chat = async (ctx) => {
    try {
        const stream = new PassThrough();
        const controller = new AbortController();
        const write = (event, data) => {
            if (!stream.writableEnded) stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        ctx.req.socket?.setTimeout?.(0);
        ctx.set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        ctx.status = 200;
        ctx.body = stream;

        const ping = setInterval(() => !stream.writableEnded && stream.write(": ping\n\n"), PING_MS);
        const timeout = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);
        ctx.req.on("close", () => controller.abort());

        ChatModule.runChat({ zai: ctx.state.zai, body: ctx.request.body, emit: write, signal: controller.signal })
            .catch(() => write("error", { code: "ZAI_UPSTREAM_ERROR", message: "zAI is unavailable right now." }))
            .finally(() => {
                clearInterval(ping);
                clearTimeout(timeout);
                stream.end();
            });
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;

        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

/**
 * Angela's signed answer (signature + body checked in middleware)
 * @param {Object} ctx - Koa context
 */
const callback = async (ctx) => {
    try {
        ctx.body = { data: await AngelaModule.recordAnswer(ctx.request.body) };
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;

        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

/**
 * Result pickup after a dropped stream (same Zelf ID only)
 * @param {Object} ctx - Koa context
 */
const getResult = async (ctx) => {
    try {
        ctx.body = { data: await AngelaModule.getResult(ctx.params.requestId, ctx.state.zai) };
    } catch (error) {
        const _exception = errorHandler(error, ctx);

        ctx.status = _exception.status;

        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

module.exports = {
    chat,
    callback,
    getResult,
    createSession,
    revokeIdentity,
    getMe,
};
