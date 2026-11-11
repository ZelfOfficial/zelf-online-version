require("dotenv").config();
const mongoose = require("mongoose");
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const VaultLegacy = require("./models/vault-legacy.model");
const { sendTestatorGracePeriod, sendLawyerLivenessFailed } = require("./modules/email");

const MONGODB_URI = process.env.MONGODB_URI || process.env.DB_URI || process.env.MONGODB_URL;
const AVALANCHE_RPC_URL = process.env.LEGACY_AVALANCHE_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc";
const CONTRACT_ADDRESS = process.env.LEGACY_VAULT_REGISTRY_ADDRESS;

async function runCronJob() {
    console.log(`\n🔍 [${new Date().toISOString()}] Cron: checking vault states from MongoDB...`);

    if (!MONGODB_URI || !CONTRACT_ADDRESS) {
        console.error("❌ Missing required environment variables (MONGODB_URI or LEGACY_VAULT_REGISTRY_ADDRESS)");
        process.exit(1);
    }

    await mongoose.connect(MONGODB_URI);
    console.log("✅ Connected to MongoDB");

    const provider = new ethers.JsonRpcProvider(AVALANCHE_RPC_URL);
    const abiPath = path.resolve(__dirname, "./contracts/VaultRegistry.json");
    const artifact = JSON.parse(fs.readFileSync(abiPath, "utf8"));
    const vaultContract = new ethers.Contract(CONTRACT_ADDRESS, artifact.abi, provider);

    const vaults = await VaultLegacy.find({});
    const now = Math.floor(Date.now() / 1000);

    let checked = 0,
        warned = 0,
        errors = 0;

    for (const entry of vaults) {
        checked++;
        const vaultId = entry.vaultId;

        try {
            const vault = await vaultContract.getVault(vaultId);
            if (!vault.exists) continue;

            const state = Number(vault.state);
            const lastPing = Number(vault.lastPing);
            const heartbeatInterval = Number(vault.heartbeatInterval);
            const timeSincePing = now - lastPing;
            const fractionElapsed = heartbeatInterval > 0 ? timeSincePing / heartbeatInterval : 0;

            let updatedEvents = false;
            const notifiedEvents = entry.notifiedEvents || {};

            if (state === 1 || state === 2) {
                const daysRemaining = Math.max(0, Math.floor((heartbeatInterval - timeSincePing) / 86400));

                if (fractionElapsed >= 0.75 && !notifiedEvents.gracePeriod) {
                    if (entry.testatorEmail) {
                        console.log(`⚠️ Vault ${vaultId}: sending grace period warning to testator`);
                        await sendTestatorGracePeriod(entry.testatorEmail, vaultId, daysRemaining).catch((e) =>
                            console.error("❌ Grace period email failed:", e.message)
                        );
                        notifiedEvents.gracePeriod = new Date().toISOString();
                        updatedEvents = true;
                        warned++;
                    }
                }

                if (fractionElapsed >= 1.0 && !notifiedEvents.livenessFailed) {
                    if (entry.lawyerEmail) {
                        const testatorAddress = vault.owner;
                        console.log(`🔔 Vault ${vaultId}: sending liveness-failed email to lawyer`);
                        await sendLawyerLivenessFailed(entry.lawyerEmail, vaultId, testatorAddress).catch((e) =>
                            console.error("❌ Liveness failed email failed:", e.message)
                        );
                        notifiedEvents.livenessFailed = new Date().toISOString();
                        updatedEvents = true;
                        warned++;
                    }
                }
            }

            if (state === 1 && fractionElapsed < 0.5) {
                if (notifiedEvents.gracePeriod || notifiedEvents.livenessFailed) {
                    delete notifiedEvents.gracePeriod;
                    delete notifiedEvents.livenessFailed;
                    updatedEvents = true;
                    console.log(`♻️ Vault ${vaultId}: reset notification flags (testator pinged)`);
                }
            }

            if (updatedEvents) {
                entry.notifiedEvents = notifiedEvents;
                entry.markModified("notifiedEvents");
                await entry.save();
            }
        } catch (e) {
            console.error(`❌ Error checking vault ${vaultId}:`, e.message);
            errors++;
        }
    }

    console.log(`✅ Cron complete: ${checked} checked, ${warned} warnings sent, ${errors} errors.`);

    await mongoose.disconnect();
    process.exit(0);
}

runCronJob().catch((err) => {
    console.error("❌ Cron failed:", err.message);
    process.exit(1);
});
