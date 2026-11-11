const { string, boolean, array, any, validateStrict } = require("../../../Core/JoiUtils");
const { verifySuperAdmin } = require("../../SuperAdmin/middlewares/verify-super-admin.middleware");

const SUPPORTED_LOCALES = ["en", "es", "fr", "ja", "ko", "pt", "zh", "zh-TW"];

const schemas = {
    create: {
        slug: string().required(),
        title: string().required(),
        description: string(),
        author: string(),
        date: any(),
        markdownContent: string().required(),
        coverImage: string(),
        imageAlt: any(),
        tags: array().items(string()),
        published: boolean(),
        canonicalSlug: string(),
        locale: string(),
    },
    update: {
        slug: string(),
        title: string(),
        description: string(),
        author: string(),
        date: any(),
        markdownContent: string(),
        coverImage: string(),
        imageAlt: any(),
        tags: array().items(string()),
        published: boolean(),
        canonicalSlug: string(),
        locale: string(),
    },
};

const rejectInvalid = (ctx, valid) => {
    const unknown = valid.error.details?.some((detail) => detail.type === "object.unknown");
    ctx.status = 409;
    ctx.body = {
        code: unknown ? "UNKNOWN_FIELD" : "VALIDATION_ERROR",
        validationError: valid.error.message,
    };
};

const createValidation = async (ctx, next) => {
    const valid = validateStrict(schemas.create, ctx.request.body);

    if (valid.error) {
        rejectInvalid(ctx, valid);
        return;
    }

    await next();
};

const updateValidation = async (ctx, next) => {
    const valid = validateStrict(schemas.update, ctx.request.body);

    if (valid.error) {
        rejectInvalid(ctx, valid);
        return;
    }

    await next();
};

/**
 * Maps :locale route param into ctx.request.query.where_locale
 * so the standard Controller.get can be reused for GET /blogs/lang/:locale.
 */
const setLocaleFromParams = async (ctx, next) => {
    const { locale } = ctx.request.params;

    if (!locale || !SUPPORTED_LOCALES.includes(locale)) {
        ctx.status = 400;
        ctx.body = { error: `Invalid locale "${locale}". Supported: ${SUPPORTED_LOCALES.join(", ")}` };
        return;
    }

    ctx.request.query = {
        ...ctx.request.query,
        where_locale: locale,
    };

    await next();
};

module.exports = {
    verifySuperAdmin,
    createValidation,
    updateValidation,
    setLocaleFromParams,
};
