const { validate } = require("../../../Core/JoiUtils");

const schemas = {
    // GET /api/presale/info takes no parameters.
    presaleInfo: {},
};

const presaleInfoValidation = async (ctx, next) => {
    const valid = validate(schemas.presaleInfo, ctx.query || {});

    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    await next();
};

module.exports = {
    presaleInfoValidation,
};
