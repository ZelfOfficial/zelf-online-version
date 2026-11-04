const { errorHandler } = require("../../../Core/http-handler");
const {
    confirmMonthlyAccess,
    getMonthlyAccessStatus,
    quoteMonthlyAccess,
} = require("../modules/zelf-id-monthly-access.module");

const sendError = (ctx, error) => {
    const exception = errorHandler(error, ctx);
    ctx.status = exception.status || error.status || 500;
    const details = error?.details && typeof error.details === "object" ? error.details : {};
    ctx.body = {
        message: details.message || exception.message,
        code: details.code || exception.code,
        ...details,
    };
};

const status = async (ctx) => {
    try {
        const named = ctx.state.monthlyAccessName;
        const data = await getMonthlyAccessStatus({
            authUser: ctx.state.user,
            zelfName: named.zelfName,
            tagName: named.tagName,
            domain: named.domain,
        });
        ctx.body = { data };
    } catch (error) {
        sendError(ctx, error);
    }
};

const quote = async (ctx) => {
    try {
        const named = ctx.state.monthlyAccessName;
        const data = await quoteMonthlyAccess({
            authUser: ctx.state.user,
            zelfName: named.zelfName,
            tagName: named.tagName,
            domain: named.domain,
        });
        ctx.body = { data };
    } catch (error) {
        sendError(ctx, error);
    }
};

const confirm = async (ctx) => {
    try {
        const body = ctx.state.monthlyAccessConfirm;
        const data = await confirmMonthlyAccess({
            authUser: ctx.state.user,
            token: body.token,
            method: body.method,
            trigger: "confirm",
        });
        ctx.body = { data };
    } catch (error) {
        sendError(ctx, error);
    }
};

module.exports = {
    confirm,
    quote,
    status,
};
