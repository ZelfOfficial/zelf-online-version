/**
 * VaultLegacy Module
 * Core business logic for ZelfLegacy vault operations.
 * Wraps IPFSManager and AvalancheManager into clean
 * service functions called from the Koa controller.
 *
 * Note: Lit Protocol operations (encrypt/decrypt) are handled by the
 * VerifikWallet hidden WebView bundle, not by this server.
 *
 * Adapted from ZelfLegacyAvax/backend/server.js
 */

const path = require("path");
const fs = require("fs");
const { ethers } = require("ethers");
const IPFSManager = require("./ipfs-legacy.module");
const AvalancheManager = require("./avalanche-legacy.module");
const { normalizeVaultId } = require("./vault-id.module");

// Lazy-initialized singletons
let _ipfsManager = null;
let _avalancheManager = null;

const getIPFSManager = () => {
    if (!_ipfsManager) {
        _ipfsManager = new IPFSManager(process.env.PINATA_API_KEY, process.env.PINATA_SECRET_KEY);
    }
    return _ipfsManager;
};

const getAvalancheManager = () => {
    if (!_avalancheManager) {
        _avalancheManager = new AvalancheManager(
            process.env.LEGACY_AVALANCHE_RPC_URL || "http://127.0.0.1:8545",
            process.env.LEGACY_VAULT_REGISTRY_ADDRESS,
            process.env.LEGACY_RELAYER_PRIVATE_KEY
        );
    }
    return _avalancheManager;
};

// ---------------------------------------------------------------------------
// Auth-sig helpers
// ---------------------------------------------------------------------------

/**
 * Verify an EIP-191 authSig object and return the recovered signer address.
 * @param {{ sig: string, signedMessage: string, address: string }} authSig
 * @param {string} [expectedPrefix]
 * @returns {string} checksummed signer address
 */
const verifyAuthSig = (authSig, expectedPrefix) => {
    if (!authSig || !authSig.sig || !authSig.signedMessage || !authSig.address) {
        throw new Error("Invalid authSig: missing fields (sig, signedMessage, address)");
    }

    let recovered;
    try {
        recovered = ethers.verifyMessage(authSig.signedMessage, authSig.sig);
    } catch (e) {
        throw new Error(`Invalid signature: ${e.message}`);
    }

    if (recovered.toLowerCase() !== authSig.address.toLowerCase()) {
        throw new Error("Signature address mismatch");
    }

    if (expectedPrefix && !authSig.signedMessage.startsWith(expectedPrefix)) {
        throw new Error(`Invalid signed message. Expected prefix: "${expectedPrefix}"`);
    }

    return recovered;
};

// ---------------------------------------------------------------------------
// Collected-shares persistence (same logic as legacy server.js)
// ---------------------------------------------------------------------------

const SHARES_FILE = path.join(__dirname, "../data/collected_shares.json");

const loadSharesFromDisk = () => {
    try {
        if (fs.existsSync(SHARES_FILE)) return JSON.parse(fs.readFileSync(SHARES_FILE, "utf8"));
    } catch (e) {
        console.warn("⚠️ Could not load shares from disk:", e.message);
    }
    return {};
};

const saveSharesToDisk = (sharesData) => {
    try {
        // Ensure data directory exists
        fs.mkdirSync(path.dirname(SHARES_FILE), { recursive: true });
        fs.writeFileSync(SHARES_FILE, JSON.stringify(sharesData, null, 2), "utf8");
    } catch (e) {
        console.error("❌ Could not persist shares to disk:", e.message);
    }
};

// ---------------------------------------------------------------------------
// Vault share operations
// ---------------------------------------------------------------------------

/**
 * Collect a beneficiary's Level-1 share.
 */
const collectShares = async ({ vaultId, beneficiaryAddress, partyShare, lawyerShare }) => {
    if (!vaultId || !beneficiaryAddress || !partyShare) {
        throw new Error("Missing required fields: vaultId, beneficiaryAddress, partyShare");
    }

    const sharesData = loadSharesFromDisk();
    if (!sharesData[vaultId]) sharesData[vaultId] = [];

    const existing = sharesData[vaultId].find((s) => s.beneficiary.toLowerCase() === beneficiaryAddress.toLowerCase());
    if (existing) {
        return { totalCollected: sharesData[vaultId].length, message: "Share already collected for this beneficiary" };
    }

    sharesData[vaultId].push({ beneficiary: beneficiaryAddress, partyShare, lawyerShare: lawyerShare || null, timestamp: Date.now() });
    saveSharesToDisk(sharesData);

    return { totalCollected: sharesData[vaultId].length, message: "Share collected successfully" };
};

/**
 * Get collected shares for a vault.
 */
const getShares = async (vaultId) => {
    const sharesData = loadSharesFromDisk();
    const vaultShares = sharesData[vaultId] || [];
    return { vaultId, shares: vaultShares, totalCollected: vaultShares.length };
};

/**
 * Get manifest from IPFS by CID.
 */
const getManifest = async (cid) => {
    const ipfsManager = getIPFSManager();
    return { manifest: await ipfsManager.retrieve(cid) };
};

/**
 * Get encrypted manifest by vaultId (looks up ipfsCidValidator on-chain).
 */
const getManifestByVault = async (vaultId) => {
    const avalancheManager = getAvalancheManager();
    const vault = await avalancheManager.getVault(vaultId);
    const manifestCID = vault.ipfsCidValidator;
    if (!manifestCID) throw Object.assign(new Error("No manifest CID found for this vault"), { status: 404 });

    const ipfsManager = getIPFSManager();
    const manifestData = await ipfsManager.retrieve(manifestCID);
    return { manifestCID, manifest: manifestData };
};

// ---------------------------------------------------------------------------
// Avalanche vault operations
// ---------------------------------------------------------------------------

const createVault = async ({
    authSig,
    beneficiaryAddresses,
    lawyerAddress,
    heartbeatInterval,
    ipfsCid,
    ipfsCidValidator,
    vaultId,
    threshold,
}) => {
    if (!authSig || !beneficiaryAddresses || !ipfsCid || !ipfsCidValidator || !vaultId || !threshold) {
        throw new Error("Missing required fields");
    }

    const vaultIdNorm = normalizeVaultId(vaultId);

    let testatorAddress;
    try {
        testatorAddress = verifyAuthSig(authSig, `ZelfLegacy create-vault ${vaultId} ${beneficiaryAddresses[0]}`);
    } catch (e) {
        const err = new Error(e.message);
        err.status = 401;
        throw err;
    }

    return await getAvalancheManager().createVault(
        testatorAddress,
        vaultIdNorm,
        beneficiaryAddresses,
        lawyerAddress,
        heartbeatInterval,
        ipfsCid,
        ipfsCidValidator,
        threshold
    );
};

const updateHeartbeat = async ({ authSig, vaultId }) => {
    if (!authSig || !vaultId) throw new Error("Missing required fields");
    let testatorAddress;
    try {
        testatorAddress = verifyAuthSig(authSig, `ZelfLegacy update-heartbeat ${vaultId}`);
    } catch (e) {
        const err = new Error(e.message);
        err.status = 401;
        throw err;
    }
    return await getAvalancheManager().updateHeartbeat(testatorAddress, vaultId);
};

const cancelVault = async ({ authSig, vaultId }) => {
    if (!authSig || !vaultId) throw new Error("Missing required fields");
    let testatorAddress;
    try {
        testatorAddress = verifyAuthSig(authSig, `ZelfLegacy cancel-vault ${vaultId}`);
    } catch (e) {
        const err = new Error(e.message);
        err.status = 401;
        throw err;
    }
    return await getAvalancheManager().cancelVault(testatorAddress, vaultId);
};

const changeLawyer = async ({ authSig, vaultId, newLawyerAddress }) => {
    if (!authSig || !vaultId || !newLawyerAddress) throw new Error("Missing required fields");
    let testatorAddress;
    try {
        testatorAddress = verifyAuthSig(authSig, `ZelfLegacy change-lawyer ${vaultId} ${newLawyerAddress}`);
    } catch (e) {
        const err = new Error(e.message);
        err.status = 401;
        throw err;
    }
    return await getAvalancheManager().changeLawyer(testatorAddress, vaultId, newLawyerAddress);
};

const confirmDeath = async ({ authSig, vaultId }) => {
    if (!authSig || !vaultId) throw new Error("Missing authSig or vaultId");
    let lawyerAddress;
    try {
        lawyerAddress = verifyAuthSig(authSig, `ZelfLegacy confirm-death ${vaultId}`);
    } catch (e) {
        const err = new Error(e.message);
        err.status = 401;
        throw err;
    }
    return await getAvalancheManager().confirmDeath(lawyerAddress, vaultId);
};

const getVault = async (vaultId) => {
    const vaultIdNorm = normalizeVaultId(vaultId);
    return { vault: await getAvalancheManager().getVault(vaultIdNorm) };
};

const getOnChainVaultOwner = async (vaultId) => {
    if (!process.env.LEGACY_VAULT_REGISTRY_ADDRESS) return null;

    try {
        const vaultIdNorm = normalizeVaultId(vaultId);
        const vault = await getAvalancheManager().getVault(vaultIdNorm);
        if (!vault?.exists || !vault.owner || vault.owner === ethers.ZeroAddress) return null;
        return vault.owner;
    } catch (error) {
        console.warn("Vault owner lookup skipped:", error.message);
        return null;
    }
};

const getBeneficiaryVaults = async (address) => {
    return { vaultIds: await getAvalancheManager().getBeneficiaryVaults(address) };
};

const getBeneficiaryVaultsData = async (address) => {
    return { vaults: await getAvalancheManager().getBeneficiaryVaultsData(address) };
};

const getOwnerVaults = async (address) => {
    return { vaultIds: await getAvalancheManager().getUserVaults(address) };
};

const getLawyerVaults = async (address) => {
    return { vaultIds: await getAvalancheManager().getLawyerVaults(address) };
};

const executeVault = async ({ authSig, vaultId }) => {
    if (!authSig || !vaultId) throw new Error("Missing authSig or vaultId");
    let beneficiaryAddress;
    try {
        beneficiaryAddress = verifyAuthSig(authSig, `ZelfLegacy execute-vault ${vaultId}`);
    } catch (e) {
        const err = new Error(e.message);
        err.status = 401;
        throw err;
    }
    return await getAvalancheManager().executeVault(beneficiaryAddress, vaultId);
};

const getExecutionStatus = async (vaultId) => {
    const status = await getAvalancheManager().getExecutionStatus(vaultId);
    return { vaultId, ...status, fullyExecuted: status.executedCount >= status.threshold };
};

const acceptVault = async ({ authSig, vaultId }) => {
    if (!authSig || !vaultId) throw new Error("Missing authSig or vaultId");
    let lawyerAddress;
    try {
        lawyerAddress = verifyAuthSig(authSig, `ZelfLegacy accept-vault ${vaultId}`);
    } catch (e) {
        const err = new Error(e.message);
        err.status = 401;
        throw err;
    }
    return await getAvalancheManager().acceptVault(lawyerAddress, vaultId);
};

const rejectVault = async ({ authSig, vaultId }) => {
    if (!authSig || !vaultId) throw new Error("Missing authSig or vaultId");
    let lawyerAddress;
    try {
        lawyerAddress = verifyAuthSig(authSig, `ZelfLegacy reject-vault ${vaultId}`);
    } catch (e) {
        const err = new Error(e.message);
        err.status = 401;
        throw err;
    }
    return await getAvalancheManager().rejectVault(lawyerAddress, vaultId);
};

module.exports = {
    verifyAuthSig,
    getOnChainVaultOwner,
    // Vault share ops
    collectShares,
    getShares,
    getManifest,
    getManifestByVault,
    // Avalanche vault ops
    createVault,
    updateHeartbeat,
    cancelVault,
    changeLawyer,
    confirmDeath,
    getVault,
    getBeneficiaryVaults,
    getBeneficiaryVaultsData,
    getOwnerVaults,
    getLawyerVaults,
    executeVault,
    getExecutionStatus,
    acceptVault,
    rejectVault,
};
