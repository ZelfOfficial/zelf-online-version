const { string, validate, stringEnum } = require("../../../Core/JoiUtils");

const digits = () => string().optional().pattern(/^\d+$/);

const schemas = {
    summary: { domain: string().optional().allow("") },
    records: {
        domain: string().optional().allow(""),
        page: digits(),
        pageSize: digits(),
        type: string().optional().allow("").max(40),
        plan: string().optional().allow("").max(40),
        origin: string().optional().allow("").max(60),
        storage: stringEnum(["IPFS", "Arweave", "ipfs", "arweave"]).optional(),
        status: stringEnum(["active", "expired"]).optional(),
        from: string().optional().allow("").max(40),
        to: string().optional().allow("").max(40),
        search: string().optional().allow("").max(100),
    },
};

const _v = (schema) => async (ctx, next) => {
    const valid = validate(schema, ctx.request.query);
    if (valid.error) {
        ctx.status = 409;
        ctx.body = { validationError: valid.error.message };
        return;
    }
    await next();
};

module.exports = { summaryValidation: _v(schemas.summary), recordsValidation: _v(schemas.records) };
