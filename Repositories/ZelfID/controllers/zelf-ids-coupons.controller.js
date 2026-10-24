const { errorHandler } = require("../../../Core/http-handler");
const Coupons = require("../modules/zelf-ids-coupons.module");

const createdByOf = async (user) => {
    const id = user?.superAdminId;
    if (!id) return "";
    try {
        const SuperAdmin = require("../../SuperAdmin/models/super-admin.model");
        const admin = await SuperAdmin.findById(id).select("email").lean();
        if (admin?.email) return String(admin.email);
    } catch (_error) {
        /* fall through to the id */
    }
    return String(id);
};

const fail = (ctx, error) => {
    const exception = errorHandler(error, ctx);
    ctx.status = exception.status;
    ctx.body = { message: exception.message, code: exception.code };
};

const create = async (ctx) => {
    try {
        const data = await Coupons.createCoupon(ctx.request.body || {}, await createdByOf(ctx.state.user));
        ctx.status = 201;
        ctx.body = { data };
    } catch (error) {
        fail(ctx, error);
    }
};

const list = async (ctx) => {
    try {
        ctx.body = { data: await Coupons.listCoupons() };
    } catch (error) {
        fail(ctx, error);
    }
};

const deactivate = async (ctx) => {
    try {
        ctx.body = { data: await Coupons.deactivateCoupon(ctx.params.id) };
    } catch (error) {
        fail(ctx, error);
    }
};

module.exports = {
    create,
    list,
    deactivate,
};
