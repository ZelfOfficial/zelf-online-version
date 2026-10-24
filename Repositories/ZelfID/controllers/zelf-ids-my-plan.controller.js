const { errorHandler } = require("../../../Core/http-handler");
const { getMyPlan } = require("../modules/zelf-ids-my-plan.module");

const myPlan = async (ctx) => {
    try {
        ctx.body = await getMyPlan({
            zelfName: ctx.state.verifiedZelfName || ctx.request.query.zelfName,
            authUser: ctx.state.user,
        });
    } catch (error) {
        const exception = errorHandler(error, ctx);
        ctx.status = exception.status;
        ctx.body = { message: exception.message, code: exception.code };
    }
};

module.exports = {
    myPlan,
};
