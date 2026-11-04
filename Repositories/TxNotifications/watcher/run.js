#!/usr/bin/env node
/**
 * Standalone received-transfer watcher (Zelf #566).
 *
 *   npm run tx-watcher              # loop: one cycle every TX_WATCHER_TICK_MS (60 s)
 *   npm run tx-watcher -- --once    # a single cycle, then exit
 *   npm run tx-watcher -- --dry-run # never call OneSignal (also TX_WATCHER_DRY_RUN=true)
 *
 * Production runs the API in pm2 cluster mode, so this must be its own pm2 app
 * with ONE instance (fork mode). A second copy is harmless: it idles until the
 * Mongo lease of the active one expires.
 */
const mongoose = require("mongoose");

const config = require("../../../Core/config");
const { warnIfTlsVerificationDisabled } = require("../../../Core/tls-verification");
const { TxWatcher } = require("./tx-watcher");

warnIfTlsVerificationDisabled();

const args = new Set(process.argv.slice(2));
const once = args.has("--once");
const dryRun = args.has("--dry-run") || Boolean(config.txNotifications?.dryRun);

let stopping = false;
let timer = null;
let cycleRunning = null;

const log = {
    info: (...parts) => console.info(new Date().toISOString(), ...parts),
    warn: (...parts) => console.warn(new Date().toISOString(), ...parts),
    error: (...parts) => console.error(new Date().toISOString(), ...parts),
};

const watcher = new TxWatcher({ dryRun, log });

const summarize = (stats) => {
    if (!stats.active) return "standby (another watcher holds the lease)";
    const pushes = Object.entries(stats.pushes || {})
        .map(([status, count]) => `${status}=${count}`)
        .join(" ");
    return [
        `cursors=${stats.cursors}`,
        `polled=${stats.polled}`,
        `failed=${stats.failed}`,
        `skipped=${stats.skipped}`,
        `transfers=${stats.transfers}`,
        stats.removedCursors ? `gc=${stats.removedCursors}` : null,
        stats.retried ? `retried=${stats.retried}` : null,
        `pushes[${pushes || "none"}]`,
        `${stats.durationMs}ms`,
    ]
        .filter(Boolean)
        .join(" ");
};

const tick = async () => {
    if (stopping) return;
    try {
        cycleRunning = watcher.runCycle();
        const stats = await cycleRunning;
        if (stats.active ? stats.cursors || stats.retried || Object.keys(stats.pushes || {}).length : once) {
            log.info(`[tx-watcher] ${summarize(stats)}`);
        }
    } catch (error) {
        // Code/name only: Mongo messages can echo key values, which contain addresses.
        log.error("[tx-watcher] cycle failed:", error?.code || error?.name || "error");
    } finally {
        cycleRunning = null;
    }

    if (once) return shutdown(0);
    if (!stopping) timer = setTimeout(tick, config.txNotifications.tickMs);
};

const shutdown = async (code = 0) => {
    if (stopping && code === 0 && !once) return;
    stopping = true;
    if (timer) clearTimeout(timer);
    try {
        // Give a running cycle a few seconds; pushes are claimed in the push log first,
        // so a watcher taking over mid-cycle cannot send anything twice.
        if (cycleRunning) await Promise.race([cycleRunning.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 8000))]);
        await watcher.releaseLease();
    } catch (_) {
        // the lease simply expires
    }
    await mongoose.disconnect().catch(() => {});
    process.exit(code);
};

const main = async () => {
    if (!config.db?.uri) {
        log.error("[tx-watcher] MONGODB_URI is not set");
        process.exit(1);
    }

    await mongoose.connect(config.db.uri);
    log.info(
        `[tx-watcher] started holder=${watcher.holder} dryRun=${dryRun} oneSignal=${config.oneSignal?.appId && config.oneSignal?.appApiKey ? "configured" : "missing"} tick=${config.txNotifications.tickMs}ms interval=${config.txNotifications.addressIntervalMs}ms`
    );

    process.on("SIGINT", () => shutdown(0));
    process.on("SIGTERM", () => shutdown(0));

    await tick();
};

main().catch((error) => {
    log.error("[tx-watcher] fatal:", error?.code || error?.name || "error");
    process.exit(1);
});
