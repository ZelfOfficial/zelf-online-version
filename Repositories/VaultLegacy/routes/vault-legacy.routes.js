/**
 * VaultLegacy Routes (Koa)
 * All routes are guarded by Bearer JWT (issued by the /sessions endpoint).
 */

const config = require("../../../Core/config");
const Controller = require("../controllers/vault-legacy.controller");
const SessionController = require("../controllers/vault-legacy-session.controller");
const RelayController = require("../controllers/vault-legacy-relay.controller");
const { requireJWT } = require("../middlewares/vault-legacy.middleware");

const BASE = "/vault-legacy";
const RELAY_BASE = "/vault-legacy/relay";

module.exports = (server) => {
    const PATH = config.basePath(BASE);
    const RELAY_PATH = config.basePath(RELAY_BASE);

    // --- Auth: unprotected session endpoint ---
    server.post(`${PATH}/sessions`, SessionController.create);

    // Retired. Kept registered so these paths answer 410 instead of falling through to JWT.
    server.get(`${PATH}/demo/status`, Controller.retiredVaultEndpoint);
    server.post(`${PATH}/demo/ensure-accepted/:vaultId`, Controller.retiredVaultEndpoint);
    server.post(`${PATH}/demo/resend-beneficiary-emails/:vaultId`, Controller.retiredVaultEndpoint);

    // --- Relay endpoints (called by the WebView JS bundle) ---
    server.post(`${RELAY_PATH}/ipfs-upload`, requireJWT, RelayController.ipfsUpload);
    server.post(`${RELAY_PATH}/send-tx`, requireJWT, RelayController.sendTx);
    server.post(`${RELAY_PATH}/register-emails`, requireJWT, RelayController.registerEmails);
    server.post(`${RELAY_PATH}/collect-share`, requireJWT, RelayController.collectShare);
    server.get(`${RELAY_PATH}/shares/:vaultId`, requireJWT, RelayController.getShares);

    // --- Vault share operations ---
    server.post(`${PATH}/vault/collect-shares`, requireJWT, Controller.collectShares);
    server.get(`${PATH}/vault/shares/:vaultId`, requireJWT, Controller.getShares);
    server.get(`${PATH}/vault/manifest/:cid`, requireJWT, Controller.getManifest);
    server.get(`${PATH}/vault/manifest-by-vault/:vaultId`, requireJWT, Controller.getManifestByVault);

    // --- Avalanche vault operations ---
    server.post(`${PATH}/avalanche/create-vault`, requireJWT, Controller.createVault);
    server.post(`${PATH}/avalanche/update-heartbeat`, requireJWT, Controller.updateHeartbeat);
    server.post(`${PATH}/avalanche/cancel-vault`, requireJWT, Controller.cancelVault);
    server.post(`${PATH}/avalanche/change-lawyer`, requireJWT, Controller.changeLawyer);
    server.post(`${PATH}/avalanche/confirm-death`, requireJWT, Controller.confirmDeath);
    server.get(`${PATH}/avalanche/vault/:vaultId`, requireJWT, Controller.getVault);
    server.get(`${PATH}/avalanche/beneficiary-vaults/:address`, requireJWT, Controller.getBeneficiaryVaults);
    server.get(`${PATH}/avalanche/beneficiary-vaults-data/:address`, requireJWT, Controller.getBeneficiaryVaultsData);
    server.get(`${PATH}/avalanche/owner-vaults/:address`, requireJWT, Controller.getOwnerVaults);
    server.get(`${PATH}/avalanche/lawyer-vaults/:address`, requireJWT, Controller.getLawyerVaults);
    server.post(`${PATH}/avalanche/execute-vault`, requireJWT, Controller.executeVault);
    server.get(`${PATH}/avalanche/execution-status/:vaultId`, requireJWT, Controller.getExecutionStatus);
    server.post(`${PATH}/avalanche/accept-vault`, requireJWT, Controller.acceptVault);
    server.post(`${PATH}/avalanche/reject-vault`, requireJWT, Controller.rejectVault);
};
