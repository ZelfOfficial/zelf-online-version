#!/usr/bin/env node
/**
 * List IPFS pins whose Pinata name matches a "pay" suffix (e.g. `.zelfpay`, `.bdagpay`),
 * then check native balances on ETH, BTC, SOL, AVAX, and BDAG using the same logic as
 * GET /api/tags/wallet-balances (Repositories/Tags/modules/tag-wallet-balances.module.js).
 *
 * Prerequisites:
 *   - Run from repo root: `cd /path/to/zelf`
 *   - `.env` loaded (Pinata, Etherscan, etc.), same as the API server
 *
 * Note: Domain config is loaded from IPFS licenses (same as the API). The script awaits
 * `loadDynamicDomains()` first; without that, `getDomainConfig('zelf')` is empty and you get
 * "Domain not supported" because standalone Node does not run `loadOfficialLicenses` like server.js.
 *
 * Usage:
 *   node scripts/audit-ipfs-pay-tags-balances.js
 *   node scripts/audit-ipfs-pay-tags-balances.js --domains=zelf --maxPins=2000 --out=./report.json
 *   node scripts/audit-ipfs-pay-tags-balances.js --domains=zelf,bdag --name=.zelfpay --concurrency=2 --delayMs=300
 *
 * Options:
 *   --domains=zelf,bdag     Registry domains to scan (default: zelf,bdag)
 *   --name=SUBSTRING        Pinata name filter (default: .{domain}pay per domain)
 *   --maxPins=N             Max pins to fetch per domain from Pinata (default: 5000, maps to IPFS.filter safety cap)
 *   --out=PATH              Output JSON file (default: ./ipfs-pay-tags-balances-audit.json)
 *   --concurrency=N         Parallel balance lookups (default: 2)
 *   --delayMs=N             Pause between batches in ms (default: 250)
 *   --networkTimeoutMs=N    Per-network HTTP cap in ms (default: 18000). Use 0 for no cap (can wait ~30s+ on BTC).
 *   --skipNetworks=a,b      Skip balance sources: eth,btc,sol,avax,bdag (e.g. skip slow BTC: --skipNetworks=btc)
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");

const TagsIPFSModule = require("../Repositories/Tags/modules/tags-ipfs.module");
const { getTagWalletBalances } = require("../Repositories/Tags/modules/tag-wallet-balances.module");
const {
    loadDynamicDomains,
    getDomainConfig,
    getSupportedDomains,
} = require("../Repositories/Tags/config/supported-domains");

function parseArgs(argv) {
    const out = {
        domains: ["zelf", "bdag"],
        name: null,
        maxPins: 5000,
        outFile: path.join(process.cwd(), "ipfs-pay-tags-balances-audit.json"),
        concurrency: 2,
        delayMs: 250,
        networkTimeoutMs: 18000,
        skipNetworks: [],
    };
    for (const arg of argv.slice(2)) {
        if (arg.startsWith("--domains=")) {
            out.domains = arg
                .slice("--domains=".length)
                .split(",")
                .map((s) => s.trim().toLowerCase())
                .filter(Boolean);
        } else if (arg.startsWith("--name=")) {
            out.name = arg.slice("--name=".length).trim();
        } else if (arg.startsWith("--maxPins=")) {
            out.maxPins = Math.max(1, parseInt(arg.slice("--maxPins=".length), 10) || 5000);
        } else if (arg.startsWith("--out=")) {
            out.outFile = path.resolve(process.cwd(), arg.slice("--out=".length).trim());
        } else if (arg.startsWith("--concurrency=")) {
            out.concurrency = Math.max(1, parseInt(arg.slice("--concurrency=".length), 10) || 2);
        } else if (arg.startsWith("--delayMs=")) {
            out.delayMs = Math.max(0, parseInt(arg.slice("--delayMs=".length), 10) || 0);
        } else if (arg.startsWith("--networkTimeoutMs=")) {
            const v = parseInt(arg.slice("--networkTimeoutMs=".length), 10);
            out.networkTimeoutMs = Number.isFinite(v) && v >= 0 ? v : 18000;
        } else if (arg.startsWith("--skipNetworks=")) {
            out.skipNetworks = arg
                .slice("--skipNetworks=".length)
                .split(",")
                .map((s) => s.trim().toLowerCase())
                .filter(Boolean);
        } else if (arg === "--help" || arg === "-h") {
            out.help = true;
        }
    }
    return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function defaultNamePattern(domain) {
    return `.${String(domain).toLowerCase()}pay`;
}

/** @param {{ value?: string|null, unit?: string, error?: string }|null|undefined} slot */
function interpretSlot(slot) {
    if (!slot) {
        return { hasBalance: false, unknown: true, display: null, error: "missing_slot", skipped: false };
    }
    if (slot.error === "skipped") {
        return { hasBalance: false, unknown: false, display: null, error: "skipped", skipped: true };
    }
    if (slot.error) {
        const unknown = true;
        return { hasBalance: false, unknown, display: null, error: slot.error, skipped: false };
    }
    if (slot.value === null || slot.value === undefined || slot.value === "") {
        return { hasBalance: false, unknown: false, display: null, error: null, skipped: false };
    }
    const raw = String(slot.value).replace(/,/g, "").trim();
    const n = parseFloat(raw);
    if (Number.isNaN(n)) {
        return { hasBalance: false, unknown: true, display: raw, error: "unparseable_value", skipped: false };
    }
    return {
        hasBalance: n > 0,
        unknown: false,
        display: `${raw} ${slot.unit}`,
        error: null,
        skipped: false,
    };
}

function extractAddresses(publicData) {
    if (!publicData || typeof publicData !== "object") {
        return { ethAddress: "", btcAddress: "", solanaAddress: "" };
    }
    const eth = (publicData.ethAddress || "").trim();
    const btc = (publicData.btcAddress || "").trim();
    const sol = (publicData.solanaAddress || "").trim();
    return { ethAddress: eth, btcAddress: btc, solanaAddress: sol };
}

async function fetchPinsForDomain(domain, namePattern, maxPins) {
    const rows = await TagsIPFSModule.searchByDomain(
        {
            domain,
            limit: maxPins,
            pageOffset: 0,
            name: namePattern,
        },
        {},
    );
    return Array.isArray(rows) ? rows : [];
}

async function runBatch(items, concurrency, fn) {
    const results = [];
    for (let i = 0; i < items.length; i += concurrency) {
        const chunk = items.slice(i, i + concurrency);
        const part = await Promise.all(chunk.map(fn));
        results.push(...part);
    }
    return results;
}

async function main() {
    const opts = parseArgs(process.argv);
    if (opts.help) {
        console.log(fs.readFileSync(__filename, "utf8").split("/**")[1].split("*/")[0]);
        process.exit(0);
    }

    console.error("[audit] loading domain registry from IPFS (licenses)…");
    let dynamic = await loadDynamicDomains(null, false);
    if (!dynamic || Object.keys(dynamic).length === 0) {
        console.error("[audit] cache empty or load failed; retrying with force=true…");
        dynamic = await loadDynamicDomains(null, true);
    }
    const available = Object.keys(getSupportedDomains());
    if (available.length === 0) {
        console.error(
            "[audit] No domains in registry after loadDynamicDomains. Check Pinata/IPFS license pins and env. Cannot continue.",
        );
        process.exit(1);
    }
    for (const d of opts.domains) {
        if (!getDomainConfig(d)) {
            console.error(
                `[audit] Domain "${d}" is not in the loaded registry. Available keys: ${available.join(", ")}`,
            );
            process.exit(1);
        }
    }
    console.error(`[audit] registry ready (${available.length} domains): ${available.join(", ")}`);
    console.error(
        `[audit] balance fetch: networkTimeoutMs=${opts.networkTimeoutMs || "none"} skipNetworks=${opts.skipNetworks.length ? opts.skipNetworks.join(",") : "(none)"}`,
    );

    const generatedAt = new Date().toISOString();
    const allRecords = [];
    const byDomainStats = {};

    for (const domain of opts.domains) {
        const namePattern = opts.name || defaultNamePattern(domain);
        console.error(`[audit] domain=${domain} name~="${namePattern}" maxPins=${opts.maxPins}`);

        let rows;
        try {
            rows = await fetchPinsForDomain(domain, namePattern, opts.maxPins);
        } catch (e) {
            console.error(`[audit] fetch failed domain=${domain}:`, e.message || e);
            byDomainStats[domain] = { error: String(e.message || e), pins: 0 };
            continue;
        }

        byDomainStats[domain] = { pins: rows.length, namePattern };

        const work = rows.map((row) => ({
            pinName: row.name || "",
            domain,
            id: row.id || null,
            cid: row.cid || row.ipfsHash || null,
            ...extractAddresses(row.publicData),
        }));

        const processOne = async (w) => {
            const entry = {
                pinName: w.pinName,
                domain: w.domain,
                id: w.id,
                cid: w.cid,
                addresses: {
                    ethAddress: w.ethAddress || null,
                    btcAddress: w.btcAddress || null,
                    solanaAddress: w.solanaAddress || null,
                },
                networks: {},
                anyBalance: false,
                anyUnknown: false,
                fetchError: null,
            };

            if (!w.ethAddress && !w.btcAddress && !w.solanaAddress) {
                entry.fetchError = "no_addresses_in_publicData";
                return entry;
            }

            try {
                const balances = await getTagWalletBalances(
                    {
                        ethAddress: w.ethAddress || undefined,
                        btcAddress: w.btcAddress || undefined,
                        solanaAddress: w.solanaAddress || undefined,
                    },
                    {
                        skipNetworks: opts.skipNetworks,
                        networkTimeoutMs: opts.networkTimeoutMs > 0 ? opts.networkTimeoutMs : 0,
                    },
                );

                for (const key of ["eth", "btc", "sol", "avax", "bdag"]) {
                    const slot = balances[key];
                    const info = interpretSlot(slot);
                    entry.networks[key] = {
                        value: slot?.value ?? null,
                        unit: slot?.unit ?? key.toUpperCase(),
                        hasBalance: info.hasBalance,
                        unknown: info.unknown,
                        skipped: info.skipped,
                        display: info.display,
                        error: slot?.error || info.error,
                    };
                    if (info.hasBalance) entry.anyBalance = true;
                    if (info.unknown) entry.anyUnknown = true;
                }
            } catch (e) {
                entry.fetchError = String(e.message || e);
                entry.anyUnknown = true;
            }

            return entry;
        };

        const processed = [];
        for (let i = 0; i < work.length; i += opts.concurrency) {
            const batch = work.slice(i, i + opts.concurrency);
            const part = await Promise.all(batch.map(processOne));
            processed.push(...part);
            if (opts.delayMs > 0 && i + opts.concurrency < work.length) {
                await sleep(opts.delayMs);
            }
        }

        allRecords.push(...processed);
        console.error(`[audit] domain=${domain} processed=${processed.length}`);
    }

    const summary = {
        totalPins: allRecords.length,
        withAnyPositiveBalance: allRecords.filter((r) => r.anyBalance).length,
        withUnknown: allRecords.filter((r) => r.anyUnknown).length,
        byNetworkPositive: {
            eth: allRecords.filter((r) => r.networks.eth?.hasBalance).length,
            btc: allRecords.filter((r) => r.networks.btc?.hasBalance).length,
            sol: allRecords.filter((r) => r.networks.sol?.hasBalance).length,
            avax: allRecords.filter((r) => r.networks.avax?.hasBalance).length,
            bdag: allRecords.filter((r) => r.networks.bdag?.hasBalance).length,
        },
    };

    const report = {
        generatedAt,
        options: {
            domains: opts.domains,
            nameOverride: opts.name,
            maxPins: opts.maxPins,
            concurrency: opts.concurrency,
            delayMs: opts.delayMs,
            networkTimeoutMs: opts.networkTimeoutMs,
            skipNetworks: opts.skipNetworks,
        },
        domainFetch: byDomainStats,
        summary,
        records: allRecords,
    };

    fs.writeFileSync(opts.outFile, JSON.stringify(report, null, 2), "utf8");
    console.error(`[audit] wrote ${opts.outFile} (${allRecords.length} records)`);
    console.log(JSON.stringify({ outFile: opts.outFile, summary }, null, 2));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
