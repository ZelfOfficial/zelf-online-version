/**
 * zAI chat orchestration (answered by Angela via her routine webhook; no model API).
 * Flow: meta → status{thinking} → prefetch scoped read-only tools → redact → POST to Angela →
 * wait for her signed callback (Mongo zai_requests) → delta chunks → server-built cards → done.
 * Events: meta {requestId, rulesVersion} · status {state:"thinking"} · delta {text} · card {...} ·
 *         done {usage, finishReason} · error {code, message}
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Angela = require("./zai-angela.module");
const Context = require("./zai-context.module");
const { redact, redactDeep } = require("./zai-redaction.module");

const RULES_PATH = path.join(__dirname, "..", "rules", "rules.md");
const HISTORY_CHAR_CAP = 24000;
const CHUNK = 48;

let _rules = null;
const loadRules = () => {
    if (_rules) return _rules;
    const text = fs.readFileSync(RULES_PATH, "utf8");
    const declared = (text.match(/\(v(\d+(?:\.\d+)*)/) || [])[1] || "0";
    const hash = crypto.createHash("sha256").update(text).digest("hex").slice(0, 8);
    _rules = { text, rulesVersion: `v${declared}+${hash}` };
    return _rules;
};

const isEnabled = () => Angela.isEnabled();

/** Newest history within the char cap, redacted. */
const buildHistory = (history = []) => {
    const out = [];
    let total = 0;
    for (let i = history.length - 1; i >= 0; i--) {
        const content = redact(String(history[i].content || ""));
        if (total + content.length > HISTORY_CHAR_CAP) break;
        total += content.length;
        out.unshift({ role: history[i].role === "assistant" ? "assistant" : "user", content });
    }
    return out;
};

/** Split text into word-boundary chunks for delta events. */
const chunkText = (text) => {
    const out = [];
    let rest = String(text || "");
    while (rest.length > CHUNK) {
        let cut = rest.lastIndexOf(" ", CHUNK);
        if (cut < 1) cut = CHUNK;
        out.push(rest.slice(0, cut + 1));
        rest = rest.slice(cut + 1);
    }
    if (rest) out.push(rest);
    return out;
};

const ERROR_MESSAGES = {
    ZAI_TIMEOUT: "zAI took too long to answer. Try again in a moment.",
    ZAI_UPSTREAM_ERROR: "zAI is unavailable right now.",
};

/**
 * Run one chat turn.
 * @param {Object} p.zai     verified identity (ctx.state.zai)
 * @param {Object} p.body    { message, history, locale } (Joi-validated)
 * @param {Function} p.emit  (event, data) => void
 * @param {AbortSignal} [p.signal]
 * @param {Object} [p.deps]  { angela, sources, fetchImpl, waitOpts } for tests
 */
const runChat = async ({ zai, body, emit, signal, deps = {}, requestId = crypto.randomUUID() }) => {
    const angela = deps.angela || Angela;
    const { rulesVersion } = loadRules();
    emit("meta", { requestId, rulesVersion });
    emit("status", { state: "thinking" });

    try {
        const question = redact(String(body.message));
        // Plan on the original text (tx hashes look like secrets to the redactor); everything sent out is redacted.
        const { toolContext, cards } = await Context.prefetch({ question: String(body.message), zai, locale: body.locale, sources: deps.sources });
        const { replyDeadline } = await angela.createRequest({ requestId, zelfName: zai.zelfName, rulesVersion, cards });

        const payload = redactDeep({
            requestId,
            question,
            history: buildHistory(body.history),
            locale: body.locale || "en",
            rulesVersion,
            zelfName: zai.zelfName,
            toolContext,
            callbackUrl: angela.CALLBACK_URL,
            replyDeadline: replyDeadline.toISOString(),
        });
        // zelfName / callbackUrl must survive redaction untouched
        payload.zelfName = zai.zelfName;
        payload.callbackUrl = angela.CALLBACK_URL;

        try {
            await angela.sendToAngela(payload, { fetchImpl: deps.fetchImpl, signal, ...(deps.sendOpts || {}) });
        } catch (error) {
            await angela.markFailed(requestId);
            throw error;
        }

        const answer = await angela.waitForAnswer(requestId, { signal, ...(deps.waitOpts || {}) });
        if (answer.status === "aborted") return;
        if (answer.status === "timeout") throw angela.zaiError(504, "ZAI_TIMEOUT");
        if (answer.status !== "answered") throw angela.zaiError(502, "ZAI_UPSTREAM_ERROR");

        const text = redact(answer.text || "");
        for (const part of chunkText(text)) emit("delta", { text: part });
        for (const card of cards) emit("card", card);
        emit("done", { usage: { toolCalls: toolContext.length }, finishReason: answer.filtered || text !== answer.text ? "filtered" : "stop" });
    } catch (error) {
        const code = error?.code === "ZAI_TIMEOUT" ? "ZAI_TIMEOUT" : "ZAI_UPSTREAM_ERROR";
        emit("error", { code, message: ERROR_MESSAGES[code], requestId });
    }
};

module.exports = { isEnabled, runChat, loadRules, _internal: { buildHistory, chunkText, resetRules: () => (_rules = null) } };
