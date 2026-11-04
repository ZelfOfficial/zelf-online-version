const { errorHandler } = require("../../../Core/http-handler");
const Chains = require("../modules/zelf-id-chain-activation.module");
const ZelfKeyModule = require("../../ZelfKeys/modules/zelf-key.module");

const send = (ctx, error) => {
    const handled = errorHandler(error, ctx);
    ctx.status = handled.status;
    ctx.body = {
        message: handled.message,
        code: handled.code,
        ...(error?.details && typeof error.details === "object" ? error.details : {}),
    };
};

const status = async (ctx) => {
    try {
        ctx.body = { data: await Chains.chainStatus(ctx.state.user) };
    } catch (error) {
        send(ctx, error);
    }
};

const activate = async (ctx) => {
    try {
        ctx.body = { data: await Chains.activateChain(ctx.state.user, ctx.request.body.chain) };
    } catch (error) {
        send(ctx, error);
    }
};

/** Same payload as GET /api/zelf-keys/limits. */
const limits = async (ctx) => {
    try {
        ctx.body = { data: await ZelfKeyModule.getVaultLimits(ctx.state.user) };
    } catch (error) {
        send(ctx, error);
    }
};

module.exports = {
    activate,
    limits,
    status,
};
