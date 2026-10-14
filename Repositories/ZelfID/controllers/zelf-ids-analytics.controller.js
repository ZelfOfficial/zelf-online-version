const Module = require("../modules/zelf-ids-analytics.module");
const { errorHandler } = require("../../../Core/http-handler");

const _wrap = (fn) => async (ctx) => {
    try {
        ctx.body = { data: await fn(ctx.request.query, ctx.state.user) };
    } catch (error) {
        const _exception = errorHandler(error, ctx);
        ctx.status = _exception.status;
        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

module.exports = {
    getSummary: _wrap(Module.getSummary),
    listRecords: _wrap(Module.listRecords),
};
