const etherscanModule = require("../../etherscan/modules/etherscan.module");
const bitcoinScrapingModule = require("../../bitcoin/modules/bitcoin-scrapping.module");
const solanaScrapingModule = require("../../Solana/modules/solana-scrapping.module");
const avalancheScrapingModule = require("../../Avalanche/modules/avalanche-scrapping.module");
const blockdagModule = require("../../BlockDAG/modules/blockdag.module");
const tonScrapingModule = require("../../TON/modules/ton-scrapping.module");
const aptosScrapingModule = require("../../Aptos/modules/aptos-scrapping.module");

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

const isEvmAddress = (a) => typeof a === "string" && EVM_ADDRESS_RE.test(a.trim());

/**
 * @param {string|number|null} value
 * @param {string} unit
 * @param {unknown} [raw]
 * @param {string} [error]
 */
const chainSlot = (value, unit, raw, error) => {
    const slot = { unit };
    if (error) {
        slot.value = null;
        slot.error = error;
    } else {
        slot.value = value;
        if (raw !== undefined) slot.raw = raw;
    }
    return slot;
};

const parseWeiToEthString = (wei) => {
    if (wei === undefined || wei === null) return null;
    const s = String(wei).trim();
    if (!/^\d+$/.test(s)) return null;
    const bn = BigInt(s);
    const whole = bn / 10n ** 18n;
    const frac = bn % 10n ** 18n;
    const fracStr = frac.toString().padStart(18, "0").replace(/0+$/, "");
    if (fracStr.length === 0) return whole.toString();
    return `${whole.toString()}.${fracStr}`;
};

const SKIPPED = Object.freeze({ __balanceSkipped: true });

const rejectAfterMs = (ms, label) =>
    new Promise((_, rej) => {
        setTimeout(() => {
            const e = new Error("network_timeout");
            e.code = "NETWORK_TIMEOUT";
            e.network = label;
            rej(e);
        }, ms);
    });

/**
 * @param {Promise<unknown>} p
 * @param {number} ms
 * @param {string} label
 */
const withOptionalTimeout = (p, ms, label) => {
    if (!ms || ms <= 0) return p;
    return Promise.race([p, rejectAfterMs(ms, label)]);
};

const rejectionMessage = (reason) => {
    if (!reason) return "unavailable";
    if (reason.code === "NETWORK_TIMEOUT" || reason.message === "network_timeout") return "network_timeout";
    return reason.message || "unavailable";
};

/**
 * Native balances for tag public addresses (ETH / BTC / SOL / AVAX C-chain / BDAG / TON / APT).
 * AVAX and BDAG use the same 0x address as ETH when present.
 *
 * @param {{ ethAddress?: string, btcAddress?: string, solanaAddress?: string, tonAddress?: string, aptosAddress?: string }} params
 * @param {{ skipNetworks?: string[], networkTimeoutMs?: number }} [options] skipNetworks: lowercase eth|btc|sol|avax|bdag|ton|aptos. networkTimeoutMs caps each network call (audit / bulk use).
 * @returns {Promise<{ eth: object, btc: object, sol: object, avax: object, bdag: object, ton: object, aptos: object }>}
 */
const getTagWalletBalances = async (params, options = {}) => {
    const eth = params.ethAddress?.trim() || "";
    const btc = params.btcAddress?.trim() || "";
    const sol = params.solanaAddress?.trim() || "";
    const ton = params.tonAddress?.trim() || "";
    const aptos = params.aptosAddress?.trim() || "";

    const evm = isEvmAddress(eth) ? eth : "";

    const skip = new Set(
        Array.isArray(options.skipNetworks) ? options.skipNetworks.map((x) => String(x).toLowerCase()) : [],
    );
    const networkTimeoutMs =
        typeof options.networkTimeoutMs === "number" && options.networkTimeoutMs > 0
            ? options.networkTimeoutMs
            : 0;

    const settled = await Promise.allSettled([
        evm
            ? skip.has("eth")
                ? Promise.resolve(SKIPPED)
                : withOptionalTimeout(etherscanModule.getBalance({ address: evm }), networkTimeoutMs, "eth")
            : Promise.resolve(null),
        btc
            ? skip.has("btc")
                ? Promise.resolve(SKIPPED)
                : withOptionalTimeout(bitcoinScrapingModule.getBalance({ id: btc }), networkTimeoutMs, "btc")
            : Promise.resolve(null),
        sol
            ? skip.has("sol")
                ? Promise.resolve(SKIPPED)
                : withOptionalTimeout(solanaScrapingModule.getAddress({ id: sol }), networkTimeoutMs, "sol")
            : Promise.resolve(null),
        evm
            ? skip.has("avax")
                ? Promise.resolve(SKIPPED)
                : withOptionalTimeout(avalancheScrapingModule.getBalance({ id: evm }), networkTimeoutMs, "avax")
            : Promise.resolve(null),
        evm
            ? skip.has("bdag")
                ? Promise.resolve(SKIPPED)
                : withOptionalTimeout(blockdagModule.fetchBdagBalance(evm), networkTimeoutMs, "bdag")
            : Promise.resolve(null),
        ton
            ? skip.has("ton")
                ? Promise.resolve(SKIPPED)
                : withOptionalTimeout(tonScrapingModule.getAddress({ id: ton }), networkTimeoutMs, "ton")
            : Promise.resolve(null),
        aptos
            ? skip.has("aptos")
                ? Promise.resolve(SKIPPED)
                : withOptionalTimeout(aptosScrapingModule.getNativeBalance(aptos), networkTimeoutMs, "aptos")
            : Promise.resolve(null),
    ]);

    let ethSlot = chainSlot(null, "ETH");
    if (!evm) {
        ethSlot = eth ? chainSlot(null, "ETH", undefined, "invalid_evm_address") : chainSlot(null, "ETH");
    } else if (settled[0].status === "fulfilled" && settled[0].value && settled[0].value.__balanceSkipped) {
        ethSlot = chainSlot(null, "ETH", undefined, "skipped");
    } else if (settled[0].status === "fulfilled" && settled[0].value) {
        const wei = settled[0].value.balance;
        const ethStr = parseWeiToEthString(wei);
        if (ethStr === null) {
            ethSlot = chainSlot(null, "ETH", { balance: wei }, "balance_unavailable");
        } else {
            ethSlot = chainSlot(ethStr, "ETH", { wei: String(wei) });
        }
    } else {
        const err =
            settled[0].status === "rejected" ? rejectionMessage(settled[0].reason) : "unavailable";
        ethSlot = chainSlot(null, "ETH", undefined, err);
    }

    let btcSlot = chainSlot(null, "BTC");
    if (!btc) {
        btcSlot = chainSlot(null, "BTC");
    } else if (settled[1].status === "fulfilled" && settled[1].value && settled[1].value.__balanceSkipped) {
        btcSlot = chainSlot(null, "BTC", undefined, "skipped");
    } else if (settled[1].status === "fulfilled" && settled[1].value) {
        const b = settled[1].value.balance;
        btcSlot = chainSlot(b != null ? String(b) : null, "BTC", undefined, b == null ? "balance_unavailable" : undefined);
    } else {
        const err =
            settled[1].status === "rejected" ? rejectionMessage(settled[1].reason) : "unavailable";
        btcSlot = chainSlot(null, "BTC", undefined, err);
    }

    let solSlot = chainSlot(null, "SOL");
    if (!sol) {
        solSlot = chainSlot(null, "SOL");
    } else if (settled[2].status === "fulfilled" && settled[2].value && settled[2].value.__balanceSkipped) {
        solSlot = chainSlot(null, "SOL", undefined, "skipped");
    } else if (settled[2].status === "fulfilled") {
        const res = settled[2].value;
        if (res && res.balance != null && res.balance !== "") {
            solSlot = chainSlot(String(res.balance), "SOL");
        } else {
            solSlot = chainSlot(null, "SOL", undefined, "unavailable");
        }
    } else {
        const err = rejectionMessage(settled[2].reason);
        solSlot = chainSlot(null, "SOL", undefined, err);
    }

    let avaxSlot = chainSlot(null, "AVAX");
    if (!evm) {
        avaxSlot = chainSlot(null, "AVAX");
    } else if (settled[3].status === "fulfilled" && settled[3].value && settled[3].value.__balanceSkipped) {
        avaxSlot = chainSlot(null, "AVAX", undefined, "skipped");
    } else if (settled[3].status === "fulfilled" && settled[3].value) {
        const b = settled[3].value.balance;
        avaxSlot = chainSlot(b != null ? String(b) : null, "AVAX", undefined, b == null ? "balance_unavailable" : undefined);
    } else {
        const err =
            settled[3].status === "rejected" ? rejectionMessage(settled[3].reason) : "unavailable";
        avaxSlot = chainSlot(null, "AVAX", undefined, err);
    }

    let bdagSlot = chainSlot(null, "BDAG");
    if (!evm) {
        bdagSlot = chainSlot(null, "BDAG");
    } else if (settled[4].status === "fulfilled" && settled[4].value && settled[4].value.__balanceSkipped) {
        bdagSlot = chainSlot(null, "BDAG", undefined, "skipped");
    } else if (settled[4].status === "fulfilled" && settled[4].value) {
        const b = settled[4].value.balance;
        bdagSlot = chainSlot(b != null ? String(b) : null, "BDAG", undefined, b == null ? "balance_unavailable" : undefined);
    } else {
        const err =
            settled[4].status === "rejected" ? rejectionMessage(settled[4].reason) : "unavailable";
        bdagSlot = chainSlot(null, "BDAG", undefined, err);
    }

    let tonSlot = chainSlot(null, "TON");
    if (!ton) {
        tonSlot = chainSlot(null, "TON");
    } else if (settled[5].status === "fulfilled" && settled[5].value && settled[5].value.__balanceSkipped) {
        tonSlot = chainSlot(null, "TON", undefined, "skipped");
    } else if (settled[5].status === "fulfilled") {
        const res = settled[5].value;
        if (res && res.balance != null && res.balance !== "") {
            tonSlot = chainSlot(String(res.balance), "TON");
        } else {
            tonSlot = chainSlot(null, "TON", undefined, "unavailable");
        }
    } else {
        const err = rejectionMessage(settled[5].reason);
        tonSlot = chainSlot(null, "TON", undefined, err);
    }

    let aptosSlot = chainSlot(null, "APT");
    if (!aptos) {
        aptosSlot = chainSlot(null, "APT");
    } else if (settled[6].status === "fulfilled" && settled[6].value && settled[6].value.__balanceSkipped) {
        aptosSlot = chainSlot(null, "APT", undefined, "skipped");
    } else if (settled[6].status === "fulfilled") {
        const balance = settled[6].value;
        aptosSlot = balance != null && balance !== "" ? chainSlot(String(balance), "APT") : chainSlot(null, "APT", undefined, "unavailable");
    } else {
        aptosSlot = chainSlot(null, "APT", undefined, rejectionMessage(settled[6].reason));
    }

    return {
        eth: ethSlot,
        btc: btcSlot,
        sol: solSlot,
        avax: avaxSlot,
        bdag: bdagSlot,
        ton: tonSlot,
        aptos: aptosSlot,
    };
};

module.exports = {
    getTagWalletBalances,
};
