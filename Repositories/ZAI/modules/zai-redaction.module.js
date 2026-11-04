/**
 * zAI redaction filter. Runs on user input, on every tool result before it reaches the model,
 * and on every outgoing delta. Replaces matches with "[redacted]". Only pattern names are ever logged.
 */
const REDACTED = "[redacted]";

const PATTERNS = [
    ["pgp_block", /-----BEGIN PGP[\s\S]*?(-----END PGP[^-]*-----|$)/g],
    ["private_key_block", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g],
    ["jwt", /eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g],
    ["mongo_uri", /mongodb(\+srv)?:\/\/[^\s"'<>]+/gi],
    ["api_key", /\b(sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,})\b/g],
    ["hex64", /\b(0x)?[0-9a-fA-F]{64}\b/g],
    ["base58_secret", /\b[1-9A-HJ-NP-Za-km-z]{87,90}\b/g],
];

// Runs of 12+ consecutive BIP-39 English words (so normal sentences are not redacted).
let _bip39 = null;
const bip39Words = () => {
    if (!_bip39) _bip39 = new Set(require("bip39").wordlists.english);
    return _bip39;
};
const redactMnemonics = (text) => {
    const words = bip39Words();
    const tokens = text.split(/(\s+)/);
    let runStart = -1;
    let runLen = 0;
    const ranges = [];
    const close = (end) => {
        if (runLen >= 12) ranges.push([runStart, end]);
        runStart = -1;
        runLen = 0;
    };
    for (let i = 0; i < tokens.length; i += 2) {
        const w = tokens[i].toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, "");
        if (w && words.has(w)) {
            if (runStart < 0) runStart = i;
            runLen++;
        } else if (tokens[i] !== "" || i === tokens.length - 1) close(i - 2);
    }
    close(tokens.length - 1);
    if (!ranges.length) return text;
    for (const [a, b] of ranges.reverse()) tokens.splice(a, b - a + 1, REDACTED);
    return tokens.join("");
};

const SECRET_ENV_NAME = /(SECRET|KEY|TOKEN|PASSWORD|PASS|MNEMONIC|PRIVATE|URI|DSN|CONNECTION)/i;

let _envSecrets = null;
const envSecrets = () => {
    if (_envSecrets) return _envSecrets;
    _envSecrets = Object.entries(process.env)
        .filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === "string" && value.length >= 8)
        .map(([, value]) => value)
        .sort((a, b) => b.length - a.length);
    return _envSecrets;
};
const resetEnvCache = () => {
    _envSecrets = null;
};

const HASH_LIKE = new Set(["hex64", "base58_secret"]);

/**
 * Returns { text, hits: [patternName] }.
 * opts.allow: Set of exact strings (tx hashes / signatures that came from tool results) kept as-is.
 * opts.skipHashLike: skip the 64-hex / long-base58 rules (used for known hash fields of tool results).
 */
const redactText = (input, opts = {}) => {
    if (typeof input !== "string" || !input) return { text: input, hits: [] };
    let text = input;
    const hits = [];
    for (const value of envSecrets()) {
        if (text.includes(value)) {
            text = text.split(value).join(REDACTED);
            hits.push("env_value");
        }
    }
    for (const [name, re] of PATTERNS) {
        if (opts.skipHashLike && HASH_LIKE.has(name)) continue;
        const next = text.replace(re, (m) => (HASH_LIKE.has(name) && opts.allow && opts.allow.has(m.replace(/^0x/, "")) ? m : REDACTED));
        if (next !== text) hits.push(name);
        text = next;
    }
    const next = redactMnemonics(text);
    if (next !== text) hits.push("mnemonic");
    return { text: next, hits };
};

const redact = (input, opts) => redactText(input, opts).text;

/** Deep-redact any JSON value (tool results). Also drops keys that look like secrets. */
const SECRET_KEY = /^(zelfProof|zelfProofQRCode|mnemonic|privateKey|secret|password|pin|faceBase64|token|apiKey|jwt|identityToken|zaiToken)$/i;
// Public chain identifiers: tx hashes/signatures/addresses are long hex/base58 by nature.
const PUBLIC_ID_KEY = /^(hash|txid|signature|explorerUrl|address|from|to|token|sourceUrl|url)$/i;
const redactDeep = (value, depth = 0, key = "") => {
    if (depth > 8) return null;
    if (typeof value === "string") return redact(value, { skipHashLike: PUBLIC_ID_KEY.test(key) });
    if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1, key));
    if (value && typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? REDACTED : redactDeep(v, depth + 1, k);
        return out;
    }
    return value;
};

/**
 * Streaming-safe redactor: holds back a tail so patterns spanning chunks are caught.
 * push(chunk) -> text safe to emit now; flush() -> remaining text.
 */
const createStreamRedactor = (holdBack = 256, allow = new Set()) => {
    let buffer = "";
    const hits = new Set();
    const run = (s) => {
        const r = redactText(s, { allow });
        r.hits.forEach((h) => hits.add(h));
        return r.text;
    };
    return {
        push(chunk) {
            buffer += chunk || "";
            if (buffer.length <= holdBack) return "";
            // Redact the whole buffer, then emit all but the tail. Cut at whitespace to avoid splitting tokens.
            const clean = run(buffer);
            let cut = clean.length - holdBack;
            const ws = clean.lastIndexOf(" ", cut);
            if (ws > 0) cut = ws + 1;
            if (cut <= 0) {
                buffer = clean;
                return "";
            }
            buffer = clean.slice(cut);
            return clean.slice(0, cut);
        },
        flush() {
            const out = run(buffer);
            buffer = "";
            return out;
        },
        hits: () => [...hits],
        allow: (id) => id && allow.add(String(id).replace(/^0x/, "")),
    };
};

module.exports = { REDACTED, redact, redactText, redactDeep, createStreamRedactor, _internal: { resetEnvCache } };
