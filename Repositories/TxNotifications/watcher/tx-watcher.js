const os = require("os");
const crypto = require("crypto");

const config = require("../../../Core/config");
const Cursor = require("../models/tx-watch-cursor.model");
const Device = require("../models/tx-notification-device.model");
const Lease = require("../models/tx-watcher-lease.model");
const PushLog = require("../models/tx-push-log.model");
const OneSignal = require("../modules/onesignal.client");
const { concurrencyFor, getAdapter } = require("../adapters");
const { mapWithConcurrency } = require("../adapters/http.util");
const { minTimestampFor, planDeliveries } = require("../modules/delivery-planner");
const { buildSummaryPayload, buildTransferPayload, summaryDigest } = require("../modules/push-message.util");
const { SEEN_CAP } = require("../models/tx-watch-cursor.model");

/**
 * Received-transfer watcher (contract #566 §4). Runs as its own process
 * (`npm run tx-watcher`), never inside the clustered API.
 *
 * Each cycle, under a Mongo lease so only one watcher is active:
 *   1. retry pushes that failed earlier (bounded),
 *   2. poll the due account cursors, network by network with concurrency caps,
 *   3. plan pushes per device (registration time, 24 h, dust, flood control),
 *   4. claim each push in the push log, then call OneSignal,
 *   5. only then save cursor progress (so a crash re-polls and the push log
 *      dedupes instead of losing transfers).
 */

const LEASE_ID = "tx-watcher";
const DAY_MS = 24 * 60 * 60 * 1000;
const RECONCILE_EVERY_MS = 10 * 60 * 1000;
const POLL_TIMEOUT_MS = 90 * 1000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const NETWORK_CIRCUIT_BREAKER = 5;
const RETRY_MAX_ATTEMPTS = 4;
const RETRY_WINDOW_MS = 6 * 60 * 60 * 1000;
const STUCK_PENDING_MS = 10 * 60 * 1000;

const settings = () => config.txNotifications || {};
const staleAfter = (now) => new Date(now + (settings().deviceStaleDays || 60) * DAY_MS);

const withTimeout = (promise, ms, code) =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const error = new Error(code);
            error.code = code;
            reject(error);
        }, ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });

/** Error code safe to log/store: ProviderError codes never contain URLs or addresses. */
const errorCode = (error) => {
    const code = error?.code;
    return typeof code === "string" && /^[a-z0-9_.-]{2,80}$/i.test(code) ? code : "unexpected_error";
};

const jitter = (ms) => Math.round(ms * (0.9 + Math.random() * 0.2));

const backoffDelay = (errorCount, intervalMs) => Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** Math.min(errorCount, 10));

class TxWatcher {
    constructor({ holder, dryRun, log = console } = {}) {
        // Under pm2 the holder is stable across restarts of the same app (pm_id), so a restarted
        // watcher takes its lease back at once instead of idling until it expires.
        this.holder =
            holder ||
            (process.env.pm_id !== undefined
                ? `${os.hostname()}:pm2-${process.env.pm_id}`
                : `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString("hex")}`);
        this.dryRun = dryRun ?? Boolean(settings().dryRun);
        this.log = log;
        this.lastReconcileAt = 0;
        this.leaseLost = false;
    }

    // ── Lease ────────────────────────────────────────────────────────────────

    async acquireLease() {
        const now = new Date();
        try {
            const lease = await Lease.findOneAndUpdate(
                { _id: LEASE_ID, $or: [{ leaseUntil: { $lt: now } }, { holder: this.holder }] },
                { $set: { holder: this.holder, leaseUntil: new Date(now.getTime() + settings().leaseMs), renewedAt: now } },
                { upsert: true, new: true }
            ).lean();
            return lease?.holder === this.holder;
        } catch (error) {
            if (error?.code === 11000) return false; // someone else holds a live lease
            throw error;
        }
    }

    async releaseLease() {
        await Lease.updateOne({ _id: LEASE_ID, holder: this.holder }, { $set: { leaseUntil: new Date(0) } });
    }

    // ── Cycle ────────────────────────────────────────────────────────────────

    /** One full cycle. Returns stats; `{ active: false }` when another watcher holds the lease. */
    async runCycle() {
        if (!(await this.acquireLease())) return { active: false };

        this.leaseLost = false;
        const renew = setInterval(async () => {
            try {
                if (!(await this.acquireLease())) this.leaseLost = true;
            } catch (_) {
                // transient Mongo error: keep going, the next renewal retries
            }
        }, Math.max(10000, Math.floor(settings().leaseMs / 3)));

        const started = Date.now();
        const stats = { active: true, cursors: 0, polled: 0, failed: 0, skipped: 0, transfers: 0, removedCursors: 0, pushes: {} };

        try {
            await this.maybeReconcile(started);
            stats.retried = await this.retryFailedPushes();

            const due = await Cursor.find({ nextCheckAt: { $lte: new Date(started) } })
                .sort({ nextCheckAt: 1 })
                .limit(settings().maxCursorsPerTick)
                .lean();
            stats.cursors = due.length;
            if (!due.length) return stats;

            const devices = await Device.find({ enabled: true, watchKeys: { $in: due.map((c) => c.key) } }).lean();
            const devicesByKey = new Map();
            for (const device of devices) {
                for (const key of device.watchKeys || []) {
                    if (!devicesByKey.has(key)) devicesByKey.set(key, []);
                    devicesByKey.get(key).push(device);
                }
            }

            const active = [];
            for (const cursor of due) {
                if (devicesByKey.has(cursor.key)) active.push(cursor);
                else if (started - new Date(cursor.createdAt || 0).getTime() > 5 * 60 * 1000) {
                    await Cursor.deleteOne({ _id: cursor._id, key: cursor.key });
                    stats.removedCursors += 1;
                }
            }

            const results = await this.pollCursors(active, devicesByKey, started);

            const transfersByKey = new Map();
            for (const [key, result] of results) {
                if (result.outcome) {
                    stats.polled += 1;
                    stats.transfers += result.outcome.transfers.length;
                    if (result.outcome.transfers.length) transfersByKey.set(key, result.outcome.transfers);
                } else if (result.error) stats.failed += 1;
                else stats.skipped += 1;
            }

            if (this.leaseLost) {
                this.log.warn("[tx-watcher] lease lost during the cycle; not sending");
                return stats;
            }

            const plans = planDeliveries({
                transfersByKey,
                devices,
                now: Date.now(),
                maxIndividual: settings().maxIndividualPushesPerCycle,
            });
            stats.pushes = await this.dispatch(plans);

            await this.commitCursors(active, results);
            return stats;
        } finally {
            clearInterval(renew);
            stats.durationMs = Date.now() - started;
        }
    }

    /** Creates cursors that enabled devices need but that are missing (e.g. removed by a race). */
    async maybeReconcile(now) {
        if (now - this.lastReconcileAt < RECONCILE_EVERY_MS) return;
        this.lastReconcileAt = now;

        const keys = await Device.distinct("watchKeys", { enabled: true });
        if (!keys.length) return;
        const existing = new Set(await Cursor.distinct("key", { key: { $in: keys } }));
        const missing = keys.filter((key) => !existing.has(key));
        if (!missing.length) return;

        await Cursor.bulkWrite(
            missing.map((key) => {
                const separator = key.indexOf(":");
                return {
                    updateOne: {
                        filter: { key },
                        update: {
                            $setOnInsert: {
                                key,
                                network: key.slice(0, separator),
                                queryAddress: key.slice(separator + 1),
                                seededAt: null,
                                state: {},
                                seen: [],
                                nextCheckAt: new Date(now),
                                errorCount: 0,
                            },
                        },
                        upsert: true,
                    },
                };
            }),
            { ordered: false }
        );
        this.log.info(`[tx-watcher] reconcile created ${missing.length} cursor(s)`);
    }

    /** Polls cursors grouped by network (networks in parallel, capped concurrency within each). */
    async pollCursors(cursors, devicesByKey, now) {
        const byNetwork = new Map();
        for (const cursor of cursors) {
            if (!byNetwork.has(cursor.network)) byNetwork.set(cursor.network, []);
            byNetwork.get(cursor.network).push(cursor);
        }

        const results = new Map();

        await Promise.all(
            [...byNetwork.entries()].map(async ([network, list]) => {
                const adapter = getAdapter(network);
                let consecutiveFailures = 0;

                await mapWithConcurrency(list, concurrencyFor(network), async (cursor) => {
                    if (!adapter) {
                        results.set(cursor.key, { error: { code: "no_adapter" } });
                        return;
                    }
                    if (this.leaseLost || consecutiveFailures >= NETWORK_CIRCUIT_BREAKER) {
                        results.set(cursor.key, { skipped: true });
                        return;
                    }

                    try {
                        const outcome = await withTimeout(
                            adapter.poll({
                                address: cursor.queryAddress,
                                state: cursor.state || {},
                                seen: new Set(cursor.seen || []),
                                minTimestampMs: minTimestampFor(cursor.key, devicesByKey.get(cursor.key), now),
                                now,
                            }),
                            POLL_TIMEOUT_MS,
                            `${network}_poll_timeout`
                        );
                        consecutiveFailures = 0;
                        results.set(cursor.key, {
                            outcome: {
                                state: outcome?.state || {},
                                transfers: (outcome?.transfers || []).map((t) => ({ ...t, network })),
                                observed: outcome?.observed || [],
                            },
                        });
                    } catch (error) {
                        consecutiveFailures += 1;
                        results.set(cursor.key, { error });
                        this.log.warn(`[tx-watcher] ${network} poll failed (${errorCode(error)}) cursor=${cursor._id}`);
                    }
                });
            })
        );

        return results;
    }

    /** Saves progress: new state and seen ids on success, exponential backoff on failure. */
    async commitCursors(cursors, results) {
        const interval = settings().addressIntervalMs;
        const operations = [];

        for (const cursor of cursors) {
            const result = results.get(cursor.key);
            if (!result || result.skipped) continue;
            const now = Date.now();

            if (result.outcome) {
                const known = new Set(cursor.seen || []);
                const fresh = [
                    ...new Set([...result.outcome.observed, ...result.outcome.transfers.map((t) => t.seenId || t.hash)].map(String)),
                ].filter((id) => id && !known.has(id));

                const update = {
                    $set: {
                        state: result.outcome.state,
                        seededAt: cursor.seededAt || new Date(now),
                        lastCheckedAt: new Date(now),
                        nextCheckAt: new Date(now + jitter(interval)),
                        errorCount: 0,
                        backoffUntil: null,
                        lastError: null,
                    },
                };
                if (fresh.length) update.$push = { seen: { $each: fresh, $slice: -SEEN_CAP } };
                operations.push({ updateOne: { filter: { _id: cursor._id }, update } });
            } else {
                const errorCount = (cursor.errorCount || 0) + 1;
                const until = new Date(now + jitter(backoffDelay(errorCount, interval)));
                operations.push({
                    updateOne: {
                        filter: { _id: cursor._id },
                        update: {
                            $set: {
                                errorCount,
                                backoffUntil: until,
                                nextCheckAt: until,
                                lastCheckedAt: new Date(now),
                                lastError: errorCode(result.error),
                            },
                        },
                    },
                });
            }
        }

        if (operations.length) await Cursor.bulkWrite(operations, { ordered: false });
    }

    // ── Delivery ─────────────────────────────────────────────────────────────

    /** Inserts the push-log row that reserves (network, hash, device). null = already pushed. */
    async claim({ network, hash, device, kind, status = "pending", payload = null }) {
        try {
            return await PushLog.create({
                network,
                hash,
                pushSubscriptionId: device.pushSubscriptionId,
                deviceId: device._id,
                kind,
                status,
                payload,
            });
        } catch (error) {
            if (error?.code === 11000) return null;
            throw error;
        }
    }

    async deliver(payload) {
        if (this.dryRun) return { outcome: "dry_run" };
        if (!OneSignal.isConfigured()) return { outcome: "failed", retryable: true, error: "onesignal_not_configured" };
        return OneSignal.sendNotification(payload);
    }

    async recordResult(logId, result, device, counters) {
        const now = new Date();
        const status = {
            sent: "sent",
            dry_run: "dry_run",
            invalid_subscription: "invalid_subscription",
        }[result.outcome] || (result.retryable === false ? "abandoned" : "failed");

        counters[status] = (counters[status] || 0) + 1;

        await PushLog.updateOne(
            { _id: logId },
            {
                $set: { status, notificationId: result.notificationId || null, lastError: result.error || null, updatedAt: now },
                $inc: { attempts: result.outcome === "dry_run" ? 0 : 1 },
            }
        );

        if (result.outcome === "sent") {
            await Device.updateOne({ _id: device._id }, { $set: { lastDeliveredAt: now, expiresAt: staleAfter(now.getTime()) } });
        } else if (result.outcome === "invalid_subscription") {
            await Device.updateOne(
                { _id: device._id, pushSubscriptionId: device.pushSubscriptionId },
                {
                    $set: {
                        enabled: false,
                        disabledReason: "onesignal_invalid_subscription",
                        disabledAt: now,
                        expiresAt: staleAfter(now.getTime()),
                    },
                }
            );
            this.log.warn(`[tx-watcher] device ${device._id} disabled: OneSignal subscription not subscribed`);
        } else if (result.outcome !== "dry_run") {
            this.log.warn(`[tx-watcher] push to device ${device._id} failed (${result.error || result.outcome})`);
        }
    }

    /**
     * Claims and sends the planned pushes. When OneSignal refuses the key or
     * rate-limits, the remaining pushes are still claimed (status `failed`, with
     * payload) so the retry pass sends them instead of losing them.
     */
    async dispatch(plans) {
        const counters = {};
        const appId = config.oneSignal?.appId || "";
        let halted = false;

        const send = async (logRow, payload, device) => {
            if (halted) {
                await PushLog.updateOne({ _id: logRow._id }, { $set: { status: "failed", lastError: "deferred", updatedAt: new Date() } });
                counters.deferred = (counters.deferred || 0) + 1;
                return "deferred";
            }
            const result = await this.deliver(payload);
            await this.recordResult(logRow._id, result, device, counters);
            if (result.outcome === "auth_error" || result.outcome === "rate_limited") {
                halted = true;
                this.log.error(`[tx-watcher] OneSignal ${result.outcome}; deferring the remaining pushes of this cycle`);
            }
            return result.outcome;
        };

        for (const { device, individual, summarized } of plans) {
            let deviceGone = false;

            for (const transfer of individual) {
                if (deviceGone) break;
                const payload = buildTransferPayload({ appId, device, transfer });
                const row = await this.claim({ network: transfer.network, hash: transfer.hash, device, kind: "individual", payload });
                if (!row) continue;
                if ((await send(row, payload, device)) === "invalid_subscription") deviceGone = true;
            }

            if (deviceGone || !summarized.length) continue;

            const claimed = [];
            for (const transfer of summarized) {
                const row = await this.claim({ network: transfer.network, hash: transfer.hash, device, kind: "summarized", status: "summarized" });
                if (row) claimed.push(transfer);
            }
            if (!claimed.length) continue;

            const payload = buildSummaryPayload({ appId, device, transfers: claimed });
            const row = await this.claim({
                network: "summary",
                hash: `summary:${summaryDigest(claimed, device.pushSubscriptionId).slice(0, 32)}`,
                device,
                kind: "summary",
                payload,
            });
            if (row) await send(row, payload, device);
        }

        return counters;
    }

    /** Re-sends failed (and stuck pending) pushes from the last hours with their stored payload. */
    async retryFailedPushes() {
        if (this.dryRun || !OneSignal.isConfigured()) return 0;

        const now = Date.now();
        const rows = await PushLog.find({
            kind: { $in: ["individual", "summary"] },
            attempts: { $lt: RETRY_MAX_ATTEMPTS },
            createdAt: { $gte: new Date(now - RETRY_WINDOW_MS) },
            payload: { $ne: null },
            $or: [{ status: "failed" }, { status: "pending", updatedAt: { $lt: new Date(now - STUCK_PENDING_MS) } }],
        })
            .sort({ createdAt: 1 })
            .limit(100)
            .lean();

        const counters = {};
        let retried = 0;
        for (const row of rows) {
            const device = await Device.findOne({ pushSubscriptionId: row.pushSubscriptionId, enabled: true }).lean();
            if (!device) {
                await PushLog.updateOne({ _id: row._id }, { $set: { status: "abandoned", lastError: "device_gone", updatedAt: new Date() } });
                continue;
            }
            const result = await this.deliver(row.payload);
            await this.recordResult(row._id, result, device, counters);
            retried += 1;
            if (result.outcome === "auth_error" || result.outcome === "rate_limited") break;
        }

        return retried;
    }
}

module.exports = {
    LEASE_ID,
    TxWatcher,
    backoffDelay,
    errorCode,
};
