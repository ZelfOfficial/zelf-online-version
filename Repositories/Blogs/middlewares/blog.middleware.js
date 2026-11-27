const { string, boolean, array, any, object, validateStrict } = require("../../../Core/JoiUtils");
const { verifyBlogSuperAdmin } = require("../../SuperAdmin/middlewares/verify-super-admin.middleware");

const SUPPORTED_LOCALES = ["en", "es", "fr", "ja", "ko", "pt", "zh", "zh-TW"];

/** Optional editor text. Joi string() rejects "" unless empty is explicitly allowed. */
const optionalText = () => string().allow("");

const faqItem = () =>
    object({
        question: optionalText().required(),
        answer: optionalText().required(),
    }).unknown(false);

/**
 * Fields shared by create and update.
 * `unknown(false)` on the root schema (validateStrict) still rejects every other key.
 */
const editorFields = () => ({
    description: optionalText(),
    author: optionalText(),
    date: any(),
    coverImage: optionalText(),
    imageAlt: optionalText(),
    caption: optionalText(),
    tags: array().items(string()),
    categories: array().items(string()),
    published: boolean(),
    canonicalSlug: optionalText(),
    locale: string(),
    metaTitle: optionalText(),
    metaDescription: optionalText(),
    faqs: array().items(faqItem()),
});

const schemas = {
    create: {
        slug: string().required(),
        title: string().required(),
        markdownContent: string().required(),
        ...editorFields(),
    },
    update: {
        slug: string(),
        title: string(),
        markdownContent: string(),
        ...editorFields(),
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
    verifySuperAdmin: verifyBlogSuperAdmin,
    verifyBlogSuperAdmin,
    createValidation,
    updateValidation,
    setLocaleFromParams,
};
