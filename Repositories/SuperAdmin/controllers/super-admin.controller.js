const Module = require("../modules/super-admin.module");

const writeError = (ctx, error) => {
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    ctx.status = status;
    ctx.body = {
        error: error.code || error.message,
        code: error.code || "SUPER_ADMIN_ERROR",
    };
};

const get = async (ctx) => {
    try {
        const data = await Module.get(ctx.request.params, ctx.state.user);

        ctx.body = { data };
    } catch (error) {
        console.error({ error });

        ctx.status = error.status || 500;

        ctx.body = { error: error.message };
    }
};

const show = async (ctx) => {
    try {
        const data = await Module.show(ctx.request.params, ctx.state.user);

        ctx.body = { data };
    } catch (error) {
        console.error(error);
        ctx.status = error.status || 500;

        ctx.body = { error: error.message };
    }
};

const create = async (ctx) => {
    try {
        const data = await Module.create(ctx.request.body, ctx.state.user);

        ctx.body = { data };
    } catch (error) {
        console.error(error);
        ctx.status = error.status || 500;

        ctx.body = { error: error.message };
    }
};

const auth = async (ctx) => {
    try {
        const data = await Module.auth(
            {
                ...ctx.request.body,
                apiKey: ctx.headers["x-api-key"],
            },
            ctx.state.user
        );

        ctx.body = { data };
    } catch (error) {
        writeError(ctx, error);
    }
};

const requestOtp = async (ctx) => {
    try {
        const data = await Module.requestOtp(ctx.request.body);
        ctx.body = { data };
    } catch (error) {
        writeError(ctx, error);
    }
};

const verifyOtp = async (ctx) => {
    try {
        const data = await Module.verifyOtp(ctx.request.body);
        ctx.body = { data };
    } catch (error) {
        writeError(ctx, error);
    }
};

const update = async (ctx) => {
    try {
        const data = await Module.update(ctx.request.body, ctx.state.user);

        ctx.body = { data };
    } catch (error) {
        console.error(error);
        ctx.status = error.status || 500;

        ctx.body = { error: error.message };
    }
};

const destroy = async (ctx) => {
    try {
        const data = await Module.destroy(ctx.request.params, ctx.state.user);

        ctx.body = { data };
    } catch (error) {
        console.error(error);
        ctx.status = error.status || 500;

        ctx.body = { error: error.message };
    }
};

module.exports = {
    get,
    show,
    create,
    update,
    destroy,
    auth,
    requestOtp,
    verifyOtp,
};
