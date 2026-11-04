const { koaBody } = require("koa-body");

/**
 * The app's body parser options. `includeUnparsed` keeps the exact bytes received in
 * ctx.request.rawBody: the Stripe webhook verifies its signature over them (re-serializing the
 * parsed JSON never matches), and the zAI callback and the Bitcoin RPC proxy read them too.
 */
const BODY_OPTIONS = {
    parsedMethods: ["POST", "PUT", "PATCH", "DELETE"],
    includeUnparsed: true,
    multipart: true,
    formLimit: "6mb",
    jsonLimit: "10mb",
    textLimit: "10mb",
    formidable: {
        keepExtensions: true,
        maxFileSize: 6 * 1024 * 1024,
    },
};

const createBodyParser = () => koaBody(BODY_OPTIONS);

module.exports = { BODY_OPTIONS, createBodyParser };
