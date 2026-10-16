const { koaBody } = require("koa-body");
const config = require("./config");

const BODY_OPTIONS = {
    parsedMethods: ["POST", "PUT", "PATCH", "DELETE"],
    multipart: true,
    formLimit: "6mb",
    jsonLimit: "10mb",
    textLimit: "10mb",
    formidable: {
        keepExtensions: true,
        maxFileSize: 6 * 1024 * 1024,
    },
};

/**
 * Routes that verify a signature over the exact bytes received. Stripe signs the raw payload;
 * re-serializing the parsed JSON never matches it, so every webhook failed verification.
 */
const RAW_BODY_PATHS = [config.basePath("/stripe/webhook")];

const _normalizePath = (path) => String(path || "").replace(/\/+$/, "").toLowerCase();

/**
 * The app's body parser. On RAW_BODY_PATHS it also keeps the unparsed body in
 * ctx.request.rawBody; everywhere else it behaves as before (no extra copy of large bodies).
 * @param {{ rawBodyPaths?: string[] }} [options]
 */
const createBodyParser = ({ rawBodyPaths = RAW_BODY_PATHS } = {}) => {
    const parse = koaBody(BODY_OPTIONS);
    const parseKeepingRaw = koaBody({ ...BODY_OPTIONS, multipart: false, includeUnparsed: true });
    const rawPaths = new Set(rawBodyPaths.map(_normalizePath));

    return (ctx, next) => (rawPaths.has(_normalizePath(ctx.path)) ? parseKeepingRaw(ctx, next) : parse(ctx, next));
};

module.exports = { createBodyParser, RAW_BODY_PATHS };
