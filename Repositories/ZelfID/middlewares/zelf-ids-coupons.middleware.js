const Joi = require("joi");

const createSchema = Joi.object({
    code: Joi.string().trim().min(1).max(64).required(),
    percentOff: Joi.number()
        .integer()
        .min(1)
        .max(100)
        .required()
        .messages({
            "number.base": '"percentOff" must be between 1 and 100',
            "number.integer": '"percentOff" must be between 1 and 100',
            "number.min": '"percentOff" must be between 1 and 100',
            "number.max": '"percentOff" must be between 1 and 100',
        }),
    plans: Joi.array().items(Joi.string().valid("premium", "unlimited")).min(1).unique().required(),
    durations: Joi.array().items(Joi.string().valid("1y", "2y", "3y", "lifetime")).unique(),
    maxRedemptions: Joi.number().integer().min(1).required(),
    perZelfIdLimit: Joi.number().integer().min(1),
    expiresAt: Joi.date().iso(),
}).unknown(true);

const requireSuperAdmin = async (ctx, next) => {
    if (!ctx.state.user || !ctx.state.user.superAdminId) {
        ctx.status = 403;
        ctx.body = { error: "Super-admin access required", code: "SUPER_ADMIN_REQUIRED" };
        return;
    }
    await next();
};

const createValidation = async (ctx, next) => {
    const valid = createSchema.validate(ctx.request.body || {}, { abortEarly: false });
    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }
    await next();
};

module.exports = {
    requireSuperAdmin,
    createValidation,
};
