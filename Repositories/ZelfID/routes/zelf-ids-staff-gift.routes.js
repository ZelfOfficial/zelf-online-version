const config = require("../../../Core/config");
const { errorHandler } = require("../../../Core/http-handler");
const { giftZelfId } = require("../modules/zelf-ids-staff-gift.module");

/** Staff-only: gift a license-priced plan to a Zelf ID (price 0, audited). */
module.exports = (server) => {
    const PATH = config.basePath("/zelf-ids/staff/gift");
    server.post(PATH, async (ctx) => {
        try {
            ctx.body = { data: await giftZelfId(ctx.request.body || {}, ctx.state.user) };
        } catch (error) {
            const _exception = errorHandler(error, ctx);
            ctx.status = _exception.status;
            ctx.body = { message: _exception.message, code: _exception.code };
        }
    });
};
