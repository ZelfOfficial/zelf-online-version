const { string, email, validate, any } = require("../../../Core/JoiUtils");

const schemas = {
    subscribe: {
        email: email().required(),
        list: string(),
        name: any(),
    },
    unsubscribe: {
        email: email().required(),
        list: string(),
    },
};

const validationFailure = (ctx, valid) => {
    const emailError = valid.error.details?.some((detail) => detail.type === "string.email" || String(detail.message || "").toLowerCase().includes("email"));
    ctx.status = 409;
    ctx.body = {
        code: emailError ? "INVALID_EMAIL" : "VALIDATION_ERROR",
        validationError: valid.error.message,
    };
};

const subscribeValidation = async (ctx, next) => {
    const valid = validate(schemas.subscribe, ctx.request.body);

    if (valid.error) {
        validationFailure(ctx, valid);

        return;
    }

    await next();
};

const unsubscribeValidation = async (ctx, next) => {
    const valid = validate(schemas.unsubscribe, ctx.request.body);

    if (valid.error) {
        validationFailure(ctx, valid);

        return;
    }

    await next();
};

module.exports = {
    subscribeValidation,
    unsubscribeValidation,
};
