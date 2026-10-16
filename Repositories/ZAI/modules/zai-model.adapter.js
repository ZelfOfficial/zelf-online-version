/**
 * Provider-neutral model adapter: OpenAI-compatible /chat/completions with tools + streaming.
 * Configured only by env (no provider is hardcoded):
 *   ZAI_MODEL_BASE_URL  e.g. https://api.<provider>/v1
 *   ZAI_MODEL           model id
 *   ZAI_MODEL_API_KEY   key (never logged, never sent to the client)
 */
const config = () => ({
    baseUrl: (process.env.ZAI_MODEL_BASE_URL || "").replace(/\/+$/, ""),
    model: process.env.ZAI_MODEL || "",
    apiKey: process.env.ZAI_MODEL_API_KEY || "",
});

const isConfigured = () => {
    const c = config();
    return !!(c.apiKey && c.baseUrl && c.model);
};

const upstreamError = (status, code) => {
    const error = new Error(`${status}:${code}`);
    error.status = status;
    error.code = code;
    error.clientCode = code;
    error.clientMessage = code;
    return error;
};

/** Parse an SSE byte stream into JSON `data:` payloads. */
async function* sseJson(body) {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of body) {
        buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") return;
            try {
                yield JSON.parse(data);
            } catch (_) {
                /* ignore keep-alives / partial junk */
            }
        }
    }
}

/**
 * One streamed completion turn.
 * @returns {Promise<{content:string, toolCalls:Array<{id,name,arguments}>, usage:Object|null, finishReason:string|null}>}
 */
const streamCompletion = async ({ messages, tools, signal, onDelta, maxTokens = 1500, fetchImpl = globalThis.fetch }) => {
    const c = config();
    if (!isConfigured()) throw upstreamError(503, "ZAI_DISABLED");

    let response;
    try {
        response = await fetchImpl(`${c.baseUrl}/chat/completions`, {
            method: "POST",
            signal,
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.apiKey}`, Accept: "text/event-stream" },
            body: JSON.stringify({
                model: c.model,
                messages,
                tools: tools && tools.length ? tools : undefined,
                tool_choice: tools && tools.length ? "auto" : undefined,
                stream: true,
                stream_options: { include_usage: true },
                max_tokens: maxTokens,
                temperature: 0.2,
            }),
        });
    } catch (error) {
        if (error?.name === "AbortError") throw upstreamError(504, "ZAI_UPSTREAM_TIMEOUT");
        throw upstreamError(502, "ZAI_UPSTREAM_ERROR");
    }
    if (!response.ok || !response.body) throw upstreamError(502, "ZAI_UPSTREAM_ERROR");

    let content = "";
    let usage = null;
    let finishReason = null;
    const calls = new Map();

    for await (const evt of sseJson(response.body)) {
        if (evt.usage) usage = evt.usage;
        const choice = evt.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (typeof delta.content === "string" && delta.content) {
            content += delta.content;
            if (onDelta) onDelta(delta.content);
        }
        for (const tc of delta.tool_calls || []) {
            const key = tc.index ?? tc.id ?? calls.size;
            const cur = calls.get(key) || { id: tc.id, name: "", arguments: "" };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.arguments += tc.function.arguments;
            calls.set(key, cur);
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    return { content, toolCalls: [...calls.values()], usage, finishReason };
};

module.exports = { isConfigured, streamCompletion, upstreamError, _internal: { sseJson, config } };
