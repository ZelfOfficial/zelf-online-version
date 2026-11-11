/**
 * Legacy demo removal.
 * Demo routes answer 410, nothing schedules the demo retry loop,
 * and the real vault, wallet decrypt, presale, and Stripe routes still load.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

process.env.LEGACY_JWT_SECRET = process.env.LEGACY_JWT_SECRET || "unit-test-legacy-jwt";

const ROOT = path.resolve(__dirname, "../..");
const SIGNER_FIXTURE = path.join(ROOT, "config", "0012589021.json");
const createdSignerFixture = !fs.existsSync(SIGNER_FIXTURE);
if (createdSignerFixture) {
    fs.mkdirSync(path.dirname(SIGNER_FIXTURE), { recursive: true });
    fs.writeFileSync(SIGNER_FIXTURE, "{}\n");
}

const Koa = require("koa");
const Router = require("@koa/router");
const { koaBody } = require("koa-body");
const request = require("supertest");

const { normalizeVaultId } = require("../../Repositories/VaultLegacy/modules/vault-id.module");
const { resolveBeneficiaryTagName } = require("../../Repositories/VaultLegacy/modules/vault-legacy-notify.module");
const registerVaultLegacy = require("../../Repositories/VaultLegacy/routes/vault-legacy.routes");
const VaultController = require("../../Repositories/VaultLegacy/controllers/vault-legacy.controller");
const RelayController = require("../../Repositories/VaultLegacy/controllers/vault-legacy-relay.controller");
const SessionController = require("../../Repositories/VaultLegacy/controllers/vault-legacy-session.controller");
const { requireJWT } = require("../../Repositories/VaultLegacy/middlewares/vault-legacy.middleware");
const registerWallet = require("../../Repositories/Wallet/routes/wallet.route");
const WalletController = require("../../Repositories/Wallet/controllers/wallet.controller");
const WalletMiddleware = require("../../Repositories/Wallet/middlewares/wallet.middleware");

const loadPaymentRoutes = () => {
    const script = `
        process.env.SOLANA_TOKEN_MINT_ADDRESS = process.env.SOLANA_TOKEN_MINT_ADDRESS || "So11111111111111111111111111111111111111112";
        process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_123";
        const Koa = require("koa");
        const Router = require("@koa/router");
        const { koaBody } = require("koa-body");
        const request = require("supertest");
        const registerStripe = require("./Repositories/Stripe/routes/stripe.routes");
        const registerPresale = require("./Repositories/PreSale/routes/pre-sale.routes");
        (async () => {
            const router = new Router();
            const app = new Koa();
            app.use(koaBody());
            registerStripe(router);
            registerPresale(router);
            app.use(router.routes());
            const find = (method, routePath) => router.stack.find((layer) => layer.path === routePath && layer.methods.includes(method));
            const names = (layer) => (layer ? layer.stack.map((fn) => fn.name) : []);
            const stripe = await request(app.callback()).post("/api/stripe/webhook").send({ type: "checkout.session.completed" });
            const presale = await request(app.callback()).post("/api/presale/create-session").send({});
            const details = await request(app.callback()).get("/api/presale/session-details");
            process.stdout.write(JSON.stringify({
                stripeHandlers: names(find("POST", "/api/stripe/webhook")),
                presaleHandlers: names(find("POST", "/api/presale/create-session")),
                detailsHandlers: names(find("GET", "/api/presale/session-details")),
                stripeStatus: stripe.status,
                stripeError: stripe.body && stripe.body.error,
                presaleStatus: presale.status,
                presaleError: presale.body && presale.body.error,
                detailsStatus: details.status,
            }));
        })().catch((error) => {
            console.error(error);
            process.exit(1);
        });
    `;
    const result = spawnSync(process.execPath, ["-e", script], {
        cwd: ROOT,
        encoding: "utf8",
        env: process.env,
    });
    if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || "payment routes failed to load");
    }
    const jsonStart = result.stdout.lastIndexOf("{");
    return JSON.parse(result.stdout.slice(jsonStart));
};

const FAKE_VAULT_ID = "0x13518f00d00000000000000000000000000000000000000000000000000000ab";

const FORBIDDEN = [
    /autoAcceptVault/,
    /ensureVaultAccepted/,
    /autoConfirmDeath/,
    /syncDemoVaultAfterCreate/,
    /vault-legacy-demo/,
    /LEGACY_DEMO_MODE/,
    /LEGACY_DEMO_LAWYER/,
    /LEGACY_DEMO_HEARTBEAT/,
    /\blegacyDemo\b/,
    /\[LEGACY-DEMO\]/,
    /\bisDemo\b/,
];

const findRoute = (router, method, routePath) =>
    router.stack.find((layer) => layer.path === routePath && layer.methods.includes(method));

const collectSourceFiles = (dir, acc = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "contracts" || entry.name === "coverage") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            collectSourceFiles(full, acc);
            continue;
        }
        if (entry.name.endsWith(".js") || entry.name.endsWith(".md") || entry.name === ".env.example") {
            acc.push(full);
        }
    }
    return acc;
};

describe("shared vault helpers kept for real flows", () => {
    it("normalizes vault ids to bytes32", () => {
        expect(normalizeVaultId("0xabc")).toBe(`0x${"abc".padStart(64, "0")}`);
        expect(normalizeVaultId(255n)).toBe(`0x${"ff".padStart(64, "0")}`);
    });

    it("resolves a beneficiary tag name for claim emails", () => {
        const entry = {
            beneficiaryEmails: ["a@b.com"],
            beneficiaryTagNames: ["alice.zelf", "aliceval.zelf"],
        };
        expect(resolveBeneficiaryTagName(entry, "0xabc", 0)).toBe("aliceval");
    });
});

describe("legacy demo removal", () => {
    const router = new Router();
    const app = new Koa();

    afterAll(() => {
        if (createdSignerFixture && fs.existsSync(SIGNER_FIXTURE)) {
            fs.unlinkSync(SIGNER_FIXTURE);
        }
    });

    beforeAll(() => {
        app.use(koaBody());
        registerVaultLegacy(router);
        registerWallet(router);
        app.use(router.routes());
        app.use(router.allowedMethods());
    });

    it("answers retired demo routes with 410 and does not retry", async () => {
        expect(findRoute(router, "GET", "/api/vault-legacy/demo/status").stack).toEqual([VaultController.retiredVaultEndpoint]);
        expect(findRoute(router, "POST", "/api/vault-legacy/demo/ensure-accepted/:vaultId").stack).toEqual([
            VaultController.retiredVaultEndpoint,
        ]);
        expect(findRoute(router, "POST", "/api/vault-legacy/demo/resend-beneficiary-emails/:vaultId").stack).toEqual([
            VaultController.retiredVaultEndpoint,
        ]);

        const status = await request(app.callback()).get("/api/vault-legacy/demo/status");
        const accepted = await request(app.callback()).post(`/api/vault-legacy/demo/ensure-accepted/${FAKE_VAULT_ID}`).send({});
        const resend = await request(app.callback())
            .post(`/api/vault-legacy/demo/resend-beneficiary-emails/${FAKE_VAULT_ID}`)
            .set("Authorization", "Bearer not-a-token")
            .send({});

        for (const response of [status, accepted, resend]) {
            expect(response.status).toBe(410);
            expect(response.body).toEqual({
                code: "LEGACY_DEMO_REMOVED",
                error: "LEGACY_DEMO_REMOVED",
            });
        }
    });

    it("still loads real vault, wallet decrypt, presale, and Stripe routes", async () => {
        expect(findRoute(router, "POST", "/api/vault-legacy/sessions").stack).toEqual([SessionController.create]);
        expect(findRoute(router, "POST", "/api/vault-legacy/relay/register-emails").stack).toEqual([
            requireJWT,
            RelayController.registerEmails,
        ]);
        expect(findRoute(router, "POST", "/api/vault-legacy/avalanche/accept-vault").stack).toEqual([
            requireJWT,
            VaultController.acceptVault,
        ]);
        expect(findRoute(router, "POST", "/api/my-wallets/decrypt").stack).toEqual([
            WalletMiddleware.decryptWalletValidation,
            WalletController.decryptWallet,
        ]);

        const session = await request(app.callback()).post("/api/vault-legacy/sessions").send({ identifier: "vault-owner-unit" });
        expect(session.status).toBe(200);
        expect(session.body.token).toEqual(expect.any(String));

        const registerEmails = await request(app.callback())
            .post("/api/vault-legacy/relay/register-emails")
            .send({ vaultId: FAKE_VAULT_ID, testatorEmail: "owner@example.com", isDemo: true });
        expect(registerEmails.status).toBe(401);
        expect(registerEmails.body.code).not.toBe("LEGACY_DEMO_REMOVED");

        const decrypt = await request(app.callback()).post("/api/my-wallets/decrypt").send({});
        expect(decrypt.status).not.toBe(404);
        expect(decrypt.status).not.toBe(410);

        const payments = loadPaymentRoutes();
        expect(payments.stripeHandlers).toEqual(["webhookValidation", "handleWebhook"]);
        expect(payments.presaleHandlers).toEqual(["createSession"]);
        expect(payments.detailsHandlers).toEqual(["getSessionDetails"]);
        expect(payments.stripeStatus).toBe(400);
        expect(payments.stripeError).toMatch(/stripe-signature/i);
        expect(payments.presaleStatus).toBe(400);
        expect(payments.presaleError).toMatch(/amount/i);
        expect(payments.detailsStatus).toBe(400);
    });

    it("does not schedule a demo job", () => {
        const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
        const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
        const scheduled = collectSourceFiles(path.join(ROOT, "scheduledJobs"));
        const vaultSources = collectSourceFiles(path.join(ROOT, "Repositories", "VaultLegacy"));
        const extra = [
            path.join(ROOT, "server.js"),
            path.join(ROOT, "package.json"),
            path.join(ROOT, "Core", "config.js"),
            path.join(ROOT, ".env.example"),
            path.join(ROOT, "AGENTS.md"),
            path.join(ROOT, ".cursor", "skills", "backend-agent-runbook", "SKILL.md"),
        ];

        expect(serverSrc).not.toMatch(/check-vaults/);
        expect(JSON.stringify(packageJson.scripts)).not.toMatch(/check-vaults|vault-legacy-demo|autoAcceptVault|ensureVaultAccepted/);

        for (const file of scheduled) {
            expect(fs.readFileSync(file, "utf8")).not.toMatch(/vault-legacy|autoAcceptVault|ensureVaultAccepted/);
        }

        const cron = fs.readFileSync(path.join(ROOT, "Repositories", "VaultLegacy", "check-vaults.js"), "utf8");
        expect(cron).toContain("sendTestatorGracePeriod");
        expect(cron).toContain("sendLawyerLivenessFailed");
        expect(cron).not.toMatch(/autoAcceptVault|ensureVaultAccepted|autoConfirmDeath/);

        expect(fs.existsSync(path.join(ROOT, "Repositories", "VaultLegacy", "modules", "vault-legacy-demo.module.js"))).toBe(false);
        expect(fs.existsSync(path.join(ROOT, "Repositories", "VaultLegacy", "DEMO-MOBILE.md"))).toBe(false);

        const offenders = [];
        for (const file of [...new Set([...vaultSources, ...extra])]) {
            const text = fs.readFileSync(file, "utf8");
            for (const pattern of FORBIDDEN) {
                if (pattern.test(text)) offenders.push(`${path.relative(ROOT, file)} matched ${pattern}`);
            }
        }
        expect(offenders).toEqual([]);
    });
});
