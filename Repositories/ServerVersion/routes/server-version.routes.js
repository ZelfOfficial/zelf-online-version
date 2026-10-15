const { execSync } = require("child_process");
const config = require("../../../Core/config");

// Resolved once at boot. Never exposes secret values, only booleans.
const run = (cmd) => {
    try {
        return execSync(cmd, { cwd: __dirname, stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).toString().trim() || null;
    } catch (e) {
        return null;
    }
};

const commit = run("git rev-parse HEAD") || process.env.FORGE_DEPLOY_COMMIT || process.env.GIT_COMMIT || process.env.SOURCE_COMMIT || "unknown";
const branch = run("git rev-parse --abbrev-ref HEAD") || process.env.FORGE_SITE_BRANCH || process.env.GIT_BRANCH || "unknown";
const startedAt = new Date().toISOString();

module.exports = (server) => {
    // Unauthenticated deploy check (distinct from /app/version, which is mobile app version gating)
    server.get(config.basePath("version"), (ctx) => {
        ctx.set("Cache-Control", "no-store");
        ctx.body = {
            commit,
            branch,
            startedAt,
            deployedAt: startedAt,
            uptimeSeconds: Math.round(process.uptime()),
            nodeVersion: process.version,
            hasV4RevenuecatWebhookAuth: Boolean(process.env.V4_REVENUECAT_WEBHOOK_AUTHORIZATION),
        };
    });
};
