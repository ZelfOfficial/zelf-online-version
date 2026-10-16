/**
 * Prefetch read-only tool results relevant to a question (no model in the loop, so the server decides).
 * Every tool is scoped to the verified zAI identity via zai-tools.runTool; results are already redacted there.
 * Returns { toolContext: [{tool, args, result}], cards } — cards are built only from these results.
 */
const Tools = require("./zai-tools.module");

const MAX_PREFETCH = Tools.MAX_TOOL_CALLS_PER_TURN; // 5
const MAX_CARDS = 8;

const RULES = [
    { tool: "get_account", re: /\b(account|cuenta|plan|expir|vence|venc|renew|renov|address|direcci[oó]n|zelf ?id|my wallet|mi billetera|term|vigencia)\b/i },
    { tool: "get_balances", re: /(?:\b|_)(balances?|saldos?|funds|fondos|how much (do|have)|cu[aá]nto tengo|holdings|tokens?)\b/i },
    { tool: "get_transactions", re: /\b(transac\w*|tx|txs|transfer\w*|sent|send|received|recib\w*|envi\w*|fail\w*|fall\w*|pending|pendiente)\b/i },
    { tool: "get_pricing", re: /\b(price|pricing|precio|cost|cuesta|cu[aá]nto (vale|cuesta)|paid|pago|plan(es)?|subscription|suscripci[oó]n)\b/i },
    { tool: "get_referrals", re: /\b(referral|referido|refer|invit\w*)\b/i },
];

const detectTxHash = (q) => {
    const evm = q.match(/\b0x[0-9a-fA-F]{64}\b/);
    if (evm) return { hash: evm[0], chain: "eth" };
    const btc = q.match(/\b[0-9a-fA-F]{64}\b/);
    if (btc) return { hash: btc[0], chain: "btc" };
    const sol = q.match(/\b[1-9A-HJ-NP-Za-km-z]{86,90}\b/);
    if (sol) return { hash: sol[0], chain: "sol" };
    return null;
};
const detectChain = (q) => (/\b(solana|sol)\b/i.test(q) ? "sol" : /\b(bitcoin|btc)\b/i.test(q) ? "btc" : /\b(ethereum|eth|erc-?20)\b/i.test(q) ? "eth" : undefined);

/** Which tools to prefetch for this question (deterministic, capped at 5). */
const plan = (question) => {
    const q = String(question || "");
    const calls = [];
    const tx = detectTxHash(q);
    if (tx) calls.push({ tool: "get_transaction", args: tx });
    const chain = detectChain(q);
    for (const r of RULES) {
        if (!r.re.test(q)) continue;
        if (r.tool === "get_transactions" && tx) continue; // a specific hash was asked: only get_transaction
        if (r.tool === "get_transactions") calls.push({ tool: r.tool, args: { chain, limit: 5 } });
        else if (r.tool === "get_balances") calls.push({ tool: r.tool, args: { chain } });
        else calls.push({ tool: r.tool, args: {} });
    }
    // Docs help almost every non-account question (how-to, security, recovery, code).
    const accountOnly = calls.length && !/\b(how|c[oó]mo|why|por ?qu[eé]|what is|qu[eé] es|recover|recuper|secur|segur|docs?)\b/i.test(q);
    if (!accountOnly) calls.push({ tool: "search_docs", args: { query: q.slice(0, 200), k: 3 } });
    return calls
        .map((c) => ({ ...c, args: Object.fromEntries(Object.entries(c.args).filter(([, v]) => v !== undefined)) }))
        .slice(0, MAX_PREFETCH);
};

const prefetch = async ({ question, zai, locale, sources }) => {
    const calls = plan(question);
    const results = await Promise.all(calls.map((c) => Tools.runTool(c.tool, c.args, zai, sources, { locale })));
    const toolContext = results.map((r, i) => ({ tool: calls[i].tool, args: calls[i].args, result: r.result }));
    const seen = new Set();
    const cards = [];
    for (const r of results)
        for (const card of r.cards) {
            const key = JSON.stringify(card);
            if (seen.has(key) || cards.length >= MAX_CARDS) continue;
            seen.add(key);
            cards.push(card);
        }
    return { toolContext, cards };
};

module.exports = { prefetch, plan, MAX_PREFETCH };
