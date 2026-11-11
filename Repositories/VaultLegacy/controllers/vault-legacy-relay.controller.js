/**
 * VaultLegacy Relay Controller (Koa)
 *
 * Handles relay endpoints called by the Android WebView JS bundle:
 *   - POST /api/vault-legacy/relay/ipfs-upload     → Pinata proxy
 *   - POST /api/vault-legacy/relay/send-tx         → broadcast pre-built calldata
 *   - POST /api/vault-legacy/relay/register-emails → email registry (MongoDB)
 *   - POST /api/vault-legacy/relay/collect-share   → in-memory share store
 *   - GET  /api/vault-legacy/relay/shares/:vaultId → retrieve collected shares
 */

const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const config = require("../../../Core/config");
const VaultLegacy = require("../models/vault-legacy.model");
const LegacyDemo = require("../modules/vault-legacy-demo.module");
const RelayerHealth = require("../modules/vault-legacy-relayer.module");

const { sendLawyerNewPlan, sendTestatorPlanActive } = require("../modules/email");

const IPFS = require("../../IPFS/modules/ipfs.module");
const { txWaitTimeoutMs, isTransactionWaitTimeout } = require("../legacy-timeouts");

// ─────────────────────────────────────────────────────────────────────────────
// Relayer wallet + contract ABI
// ─────────────────────────────────────────────────────────────────────────────
const AVALANCHE_RPC_URL = process.env.LEGACY_AVALANCHE_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc";
const RELAYER_PRIVATE_KEY = process.env.LEGACY_RELAYER_PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.LEGACY_VAULT_REGISTRY_ADDRESS;

let provider = null;
let relayerWallet = null;
let iface = null;

function initRelayer() {
    if (relayerWallet) return;

    if (!RELAYER_PRIVATE_KEY) {
        console.warn("⚠️  LEGACY_RELAYER_PRIVATE_KEY not set — relay/send-tx will fail");
        return;
    }

    provider = new ethers.JsonRpcProvider(AVALANCHE_RPC_URL);
    relayerWallet = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);
    console.log(`🔑 VaultLegacy relayer wallet: ${relayerWallet.address}`);

    try {
        const abiPath = path.resolve(__dirname, "../contracts/VaultRegistry.json");
        const artifact = JSON.parse(fs.readFileSync(abiPath, "utf8"));
        iface = new ethers.Interface(artifact.abi);
    } catch {
        console.warn("⚠️  VaultRegistry ABI not found — calldata decoding disabled");
    }

    if (CONTRACT_ADDRESS) {
        RelayerHealth.getRelayerHealth()
            .then((health) => {
                if (!health.onChainRelayer) return;
                if (health.relayerMatches) {
                    console.log(`✅ VaultLegacy relayer matches contract relayer(): ${health.onChainRelayer}`);
                } else {
                    console.error(
                        `❌ VaultLegacy RELAYER MISMATCH — server ${health.serverRelayer} ≠ contract ${health.onChainRelayer}. ` +
                            "createVault will revert with 'Not authorized to create vault'."
                    );
                }
            })
            .catch((e) => console.warn("⚠️  Relayer health check failed:", e.message));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory share store (collect-share / get-shares)
// ─────────────────────────────────────────────────────────────────────────────
const collectedShares = {};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vault-legacy/relay/ipfs-upload
// ─────────────────────────────────────────────────────────────────────────────
const ipfsUpload = async (ctx) => {
    try {
        const { data, filename } = ctx.request.body;

        const name = filename || "zelf-data";
        const base64 = Buffer.from(JSON.stringify(data)).toString("base64");
        const metadata = { name };

        const result = await IPFS.insert({ base64, metadata, name, pinIt: true }, { pro: true });

        if (!result?.cid && !result?.ipfsHash) {
            ctx.status = 502;
            ctx.body = { error: "IPFS upload failed" };
            return;
        }

        const ipfsHash = result.cid || result.ipfsHash;
        console.log(`✅ IPFS Proxy Upload: ${ipfsHash}`);
        ctx.body = { ipfsHash };
    } catch (error) {
        ctx.status = 500;
        ctx.body = { error: error.message };
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vault-legacy/relay/register-emails
// ─────────────────────────────────────────────────────────────────────────────
const registerEmails = async (ctx) => {
    try {
        const { vaultId, testatorEmail, lawyerEmail, beneficiaryEmails, beneficiaryTagNames, isDemo } = ctx.request.body;

        if (!vaultId) {
            ctx.status = 400;
            ctx.body = { error: "Missing vaultId" };
            return;
        }

        const vaultIdNorm = LegacyDemo.normalizeVaultId(vaultId);
        const wantsDemo = isDemo === true;

        if (wantsDemo) {
            LegacyDemo.assertDemoModeEnabled();
        }

        const update = {
            testatorEmail: testatorEmail || null,
            lawyerEmail: lawyerEmail || null,
            beneficiaryEmails: beneficiaryEmails || [],
            beneficiaryTagNames: beneficiaryTagNames || [],
        };

        if (wantsDemo) {
            update.isDemo = true;
        }

        await VaultLegacy.findOneAndUpdate(
            { vaultId: vaultIdNorm },
            { $set: update },
            { upsert: true, new: true }
        );

        console.log(`📋 Registered emails for vault ${vaultIdNorm} (MongoDB)${wantsDemo ? " [demo]" : ""}`);
        ctx.body = { success: true, vaultId: vaultIdNorm, isDemo: wantsDemo };
    } catch (error) {
        ctx.status = 500;
        ctx.body = { error: error.message };
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vault-legacy/relay/send-tx
// ─────────────────────────────────────────────────────────────────────────────
const sendTx = async (ctx) => {
    try {
        initRelayer();
        if (!relayerWallet) {
            ctx.status = 503;
            ctx.body = { error: "Relayer not configured" };
            return;
        }

        const { to, calldata, value } = ctx.request.body;
        if (!to || !calldata) {
            ctx.status = 400;
            ctx.body = { error: "Missing required fields: to, calldata" };
            return;
        }

        let fnName = "unknown";
        let decoded = null;
        if (iface) {
            try {
                decoded = iface.parseTransaction({ data: calldata });
                fnName = decoded?.name || "unknown";
            } catch {}
        }
        console.log(`📡 Relaying tx → ${fnName} (${calldata.substring(0, 10)}...)`);

        if (fnName === "createVault") {
            await RelayerHealth.assertRelayerMatchesContract();
        }

        const tx = await relayerWallet.sendTransaction({ to, data: calldata, value: value || "0x0" });
        console.log(`📤 Tx sent: ${tx.hash}`);
        let receipt;
        try {
            receipt = await tx.wait(1, txWaitTimeoutMs);
        } catch (waitErr) {
            if (isTransactionWaitTimeout(waitErr)) {
                ctx.status = 504;
                ctx.body = { error: "Transaction confirmation timed out", txHash: tx.hash };
                return;
            }
            throw waitErr;
        }
        console.log(`✅ Confirmed in block ${receipt.blockNumber}`);

        // ── Email notification hooks (fire-and-forget) ──────────────────────
        if (decoded) {
            try {
                if (fnName === "createVault") {
                    const vaultId = decoded.args[1];
                    const vaultIdHex = LegacyDemo.normalizeVaultId(
                        typeof vaultId === "bigint" ? vaultId : vaultId.toString()
                    );
                    const testatorAddress = decoded.args[0];
                    const lawyerAddress = decoded.args[3];

                    let demoAcceptResult = null;
                    if (config.legacyDemo?.enabled && LegacyDemo.isDemoLawyerAddress(lawyerAddress)) {
                        try {
                            demoAcceptResult = await LegacyDemo.syncDemoVaultAfterCreate({
                                vaultId: vaultIdHex,
                                lawyerAddress,
                            });
                            console.log(`[LEGACY-DEMO] syncDemoVaultAfterCreate:`, demoAcceptResult?.reason || "accepted");
                        } catch (e) {
                            console.error("[LEGACY-DEMO] syncDemoVaultAfterCreate failed:", e.message);
                        }
                    }

                    const entry = await VaultLegacy.findOne({ vaultId: vaultIdHex });
                    if (!demoAcceptResult?.success && !entry?.isDemo && entry?.lawyerEmail) {
                        console.log(`📧 Sending "new plan" email to lawyer ${entry.lawyerEmail}`);
                        sendLawyerNewPlan(entry.lawyerEmail, vaultIdHex, testatorAddress).catch((e) =>
                            console.error("❌ Lawyer email failed:", e.message)
                        );
                    }
                } else if (fnName === "acceptVault") {
                    const vaultIdHex = LegacyDemo.normalizeVaultId(decoded.args[0]);
                    const entry = await VaultLegacy.findOne({ vaultId: vaultIdHex });
                    if (entry?.testatorEmail) {
                        console.log(`📧 Sending "plan active" email to testator ${entry.testatorEmail}`);
                        sendTestatorPlanActive(entry.testatorEmail, vaultIdHex).catch((e) =>
                            console.error("❌ Testator active email failed:", e.message)
                        );
                    }
                } else if (fnName === "confirmDeath") {
                    const vaultIdHex = LegacyDemo.normalizeVaultId(decoded.args[0]);
                    const entry = await VaultLegacy.findOne({ vaultId: vaultIdHex });

                    if (entry) {
                        LegacyDemo.ensureBeneficiaryClaimableEmails(entry, vaultIdHex).catch((e) =>
                            console.error("❌ Beneficiary claimable emails failed:", e.message)
                        );
                    }
                }
            } catch (emailErr) {
                console.error("⚠️ Email hook error (non-fatal):", emailErr.message);
            }
        }

        ctx.body = { txHash: tx.hash, blockNumber: receipt.blockNumber };
    } catch (error) {
        ctx.status = 500;
        ctx.body = { error: error.message };
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vault-legacy/relay/collect-share
// ─────────────────────────────────────────────────────────────────────────────
const collectShare = async (ctx) => {
    const { vaultId, beneficiaryAddress, partyShare, lawyerShare } = ctx.request.body;

    if (!collectedShares[vaultId]) collectedShares[vaultId] = [];

    const existing = collectedShares[vaultId].find((s) => s.beneficiary === beneficiaryAddress);
    if (!existing) {
        collectedShares[vaultId].push({ beneficiary: beneficiaryAddress, partyShare, lawyerShare });
    }

    ctx.body = { success: true, count: collectedShares[vaultId].length };
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vault-legacy/relay/shares/:vaultId
// ─────────────────────────────────────────────────────────────────────────────
const getShares = async (ctx) => {
    const shares = collectedShares[ctx.params.vaultId] || [];
    ctx.body = { shares };
};

module.exports = {
    ipfsUpload,
    sendTx,
    registerEmails,
    collectShare,
    getShares,
};
