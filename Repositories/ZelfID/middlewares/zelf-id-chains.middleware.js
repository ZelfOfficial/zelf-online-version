const Joi = require("joi");

const { requireVerifiedWallet } = require("../../ZelfKeys/middlewares/zelf-key.middleware");

const activateSchema = Joi.object({
    chain: Joi.string().trim().min(1).max(64).required(),
}).unknown(true);

const statusValidation = async (ctx, next) => {
    if (!(await requireVerifiedWallet(ctx))) return;
    await next();
};

const activateValidation = async (ctx, next) => {
    if (!(await requireVerifiedWallet(ctx))) return;

    const valid = activateSchema.validate(ctx.request.body || {}, { abortEarly: false, convert: true, stripUnknown: false });
    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    ctx.request.body = { ...ctx.request.body, ...valid.value };
    await next();
};

module.exports = {
    activateValidation,
    statusValidation,
};
