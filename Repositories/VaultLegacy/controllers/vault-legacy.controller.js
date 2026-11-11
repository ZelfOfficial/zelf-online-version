/**
 * VaultLegacy Controller (Koa)
 * Routes handler layer adapted from ZelfLegacyAvax Express endpoints.
 */

const Module = require("../modules/vault-legacy.module");

const sendError = (ctx, error) => {
    ctx.status = error.status || 500;
    const body = { error: error.message };
    if (error.txHash) body.txHash = error.txHash;
    ctx.body = body;
};

// ---- Vault share endpoints ----

const collectShares = async (ctx) => {
    try {
        const result = await Module.collectShares(ctx.request.body);
        ctx.body = { success: true, ...result };
    } catch (error) {
        sendError(ctx, error);
    }
};

const getShares = async (ctx) => {
    try {
        const result = await Module.getShares(ctx.params.vaultId);
        ctx.body = { success: true, ...result };
    } catch (error) {
        sendError(ctx, error);
    }
};

const getManifest = async (ctx) => {
    try {
        const result = await Module.getManifest(ctx.params.cid);
        ctx.body = { success: true, ...result };
    } catch (error) {
        sendError(ctx, error);
    }
};

const getManifestByVault = async (ctx) => {
    try {
        const result = await Module.getManifestByVault(ctx.params.vaultId);
        ctx.body = { success: true, ...result };
    } catch (error) {
        sendError(ctx, error);
    }
};

// ---- Avalanche vault endpoints ----

const createVault = async (ctx) => {
    try {
        const result = await Module.createVault(ctx.request.body);
        ctx.body = { success: true, ...result };
    } catch (error) {
        sendError(ctx, error);
    }
};

const updateHeartbeat = async (ctx) => {
    try {
        const result = await Module.updateHeartbeat(ctx.request.body);
        ctx.body = { success: true, ...result };
    } catch (error) {
        sendError(ctx, error);
    }
};

const cancelVault = async (ctx) => {
    try {
        const result = await Module.cancelVault(ctx.request.body);
        ctx.body = { success: true, ...result };
    } catch (error) {
        sendError(ctx, error);
    }
};

const changeLawyer = async (ctx) => {
    try {
        const result = await Module.changeLawyer(ctx.request.body);
        ctx.body = { success: true, ...result };
    } catch (error) {
        sendError(ctx, error);
    }
};

const confirmDeath = async (ctx) => {
    try {
        const result = await Module.confirmDeath(ctx.request.body);
        ctx.body = { success: true, result };
    } catch (error) {
        sendError(ctx, error);
    }
};

const getVault = async (ctx) => {
    try {
        const result = await Module.getVault(ctx.params.vaultId);
        ctx.body = { success: true, ...result };
    } catch (error) {
        sendError(ctx, error);
    }
};

const getBeneficiaryVaults = async (ctx) => {
    try {
        const result = await Module.getBeneficiaryVaults(ctx.params.address);
        ctx.body = { success: true, ...result };
    } catch (error) {
        sendError(ctx, error);
    }
};

const getBeneficiaryVaultsData = async (ctx) => {
    try {
        const result = await Module.getBeneficiaryVaultsData(ctx.params.address);
        ctx.body = { success: true, ...result };
    } catch (error) {
        sendError(ctx, error);
    }
};

const getOwnerVaults = async (ctx) => {
    try {
        const result = await Module.getOwnerVaults(ctx.params.address);
        ctx.body = { success: true, ...result };
    } catch (error) {
        sendError(ctx, error);
    }
};

const getLawyerVaults = async (ctx) => {
    try {
        const result = await Module.getLawyerVaults(ctx.params.address);
        ctx.body = { success: true, ...result };
    } catch (error) {
        sendError(ctx, error);
    }
};

const executeVault = async (ctx) => {
    try {
        const result = await Module.executeVault(ctx.request.body);
        ctx.body = { success: true, ...result };
    } catch (error) {
        sendError(ctx, error);
    }
};

const getExecutionStatus = async (ctx) => {
    try {
        const result = await Module.getExecutionStatus(ctx.params.vaultId);
        ctx.body = { success: true, ...result };
    } catch (error) {
        sendError(ctx, error);
    }
};

const acceptVault = async (ctx) => {
    try {
        const result = await Module.acceptVault(ctx.request.body);
        ctx.body = { success: true, result };
    } catch (error) {
        sendError(ctx, error);
    }
};

const rejectVault = async (ctx) => {
    try {
        const result = await Module.rejectVault(ctx.request.body);
        ctx.body = { success: true, result };
    } catch (error) {
        sendError(ctx, error);
    }
};

const retiredVaultEndpoint = (ctx) => {
    ctx.status = 410;
    ctx.body = {
        code: "LEGACY_DEMO_REMOVED",
        error: "LEGACY_DEMO_REMOVED",
    };
};

module.exports = {
    collectShares,
    getShares,
    getManifest,
    getManifestByVault,
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
    retiredVaultEndpoint,
};
