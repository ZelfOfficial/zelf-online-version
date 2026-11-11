const Joi = require("joi");

// Mirrors the client-side SAFE_NAME_REGEX.
// Only letters, numbers, spaces, hyphens, underscores, periods and apostrophes are allowed.
// Special characters like / : @ # ? & = % + \ break IPFS/Pinata storage paths and Koa route segments.
const SAFE_NAME_PATTERN = /^[a-zA-Z0-9 \-_.']+$/;
const SAFE_SYMBOL_PATTERN = /^[A-Z0-9]{1,6}$/;

const createCollectionValidation = async (ctx, next) => {
    const schema = Joi.object({
        name: Joi.string().pattern(SAFE_NAME_PATTERN).required().messages({
            "string.pattern.base": "Collection name contains invalid characters. Use only letters, numbers, spaces, hyphens, and underscores.",
        }),
        symbol: Joi.string().pattern(SAFE_SYMBOL_PATTERN).required().messages({
            "string.pattern.base": "Collection symbol must be 1–6 uppercase letters/numbers (e.g. ART, NFT1).",
        }),
        description: Joi.string().optional().allow(""),
        coverImage: Joi.string().optional(),
        avatarImage: Joi.string().optional(),
        contractAddress: Joi.string().required(),
        owner: Joi.string().required(),
        maxSupply: Joi.number().optional(),
        royaltyBps: Joi.number().optional(),
        chainId: Joi.number().optional(),
        createdAt: Joi.string().optional(),
        walletType: Joi.string().valid("zelf", "external").required(),
        // Zelf Auth
        proof: Joi.string().optional(),
        faceBase64: Joi.string().optional(),
        password: Joi.string().optional(),
        // External Auth
        signature: Joi.string().optional(),
        message: Joi.string().optional(),
        // Collection Meta
        category: Joi.string().optional(),
    }).unknown(true);

    const { error } = schema.validate(ctx.request.body);
    if (error) {
        ctx.status = 400;
        ctx.body = { error: error.details[0].message };
        return;
    }
    await next();
};

const createNFTValidation = async (ctx, next) => {
    const schema = Joi.object({
        name: Joi.string().pattern(SAFE_NAME_PATTERN).required().messages({
            "string.pattern.base": "NFT name contains invalid characters. Use only letters, numbers, spaces, hyphens, and underscores.",
        }),
        description: Joi.string().max(5000).optional().allow(""),
        image: Joi.string().required(),
        attributes: Joi.array().items(Joi.object()).optional(),
        collectionAddress: Joi.string().optional(), // Can be null if standalone or if we assume collection-less
        owner: Joi.string().required(),
        walletType: Joi.string().valid("zelf", "external").required(),
        // Zelf Auth
        proof: Joi.string().optional(),
        faceBase64: Joi.string().optional(),
        password: Joi.string().optional(),
        // External Auth
        signature: Joi.string().optional(),
        message: Joi.string().optional(),
        // NFT Meta
        category: Joi.string().optional(),
    });

    const { error } = schema.validate(ctx.request.body);
    if (error) {
        ctx.status = 400;
        ctx.body = { error: error.details[0].message };
        return;
    }
    await next();
};

const mintNFTValidation = async (ctx, next) => {
    const schema = Joi.object({
        collectionAddress: Joi.string().required(),
        recipientAddress: Joi.string().required(),
        tokenURI: Joi.string().required(),
        owner: Joi.string().required(),
        walletType: Joi.string().valid("zelf", "external").required(),
        // Zelf Auth
        proof: Joi.string().optional(),
        faceBase64: Joi.string().optional(),
        password: Joi.string().optional(),
        // External Auth
        signature: Joi.string().required(),
        message: Joi.string().required(),
    });

    const { error } = schema.validate(ctx.request.body);
    if (error) {
        ctx.status = 400;
        ctx.body = { error: error.details[0].message };
        return;
    }
    await next();
};

const updateTokenIdValidation = async (ctx, next) => {
    const schema = Joi.object({
        tokenId: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
        txHash: Joi.string().optional().allow(""),
        owner: Joi.string().required(),
        walletType: Joi.string().valid("zelf", "external").required(),
        proof: Joi.string().optional(),
        faceBase64: Joi.string().optional(),
        password: Joi.string().optional(),
        signature: Joi.string().required(),
        message: Joi.string().required(),
    });

    const { error } = schema.validate(ctx.request.body);
    if (error) {
        ctx.status = 400;
        ctx.body = { error: error.details[0].message };
        return;
    }
    await next();
};

const deleteCollectionValidation = async (ctx, next) => {
    const schema = Joi.object({
        walletType: Joi.string().valid("zelf", "external").required(),
        owner: Joi.string().required(),
        proof: Joi.string().optional(),
        faceBase64: Joi.string().optional(),
        password: Joi.string().optional(),
        signature: Joi.string().required(),
        message: Joi.string().required(),
    });

    const { error } = schema.validate(ctx.request.body);
    if (error) {
        ctx.status = 400;
        ctx.body = { error: error.details[0].message };
        return;
    }
    await next();
};

const deleteItemValidation = async (ctx, next) => {
    const schema = Joi.object({
        walletType: Joi.string().valid("zelf", "external").required(),
        owner: Joi.string().required(),
        proof: Joi.string().optional(),
        faceBase64: Joi.string().optional(),
        password: Joi.string().optional(),
        signature: Joi.string().required(),
        message: Joi.string().required(),
    });

    const { error } = schema.validate(ctx.request.body);
    if (error) {
        ctx.status = 400;
        ctx.body = { error: error.details[0].message };
        return;
    }
    await next();
};

const updateCollectionValidation = async (ctx, next) => {
    const schema = Joi.object({
        coverImage: Joi.string().optional().allow(""),
        avatarImage: Joi.string().optional().allow(""),
        name: Joi.string().pattern(SAFE_NAME_PATTERN).optional().allow("").messages({
            "string.pattern.base": "Collection name contains invalid characters. Use only letters, numbers, spaces, hyphens, and underscores.",
        }),
        walletType: Joi.string().valid("zelf", "external").required(),
        owner: Joi.string().required(),
        proof: Joi.string().optional(),
        faceBase64: Joi.string().optional(),
        password: Joi.string().optional(),
        signature: Joi.string().optional(),
        message: Joi.string().optional(),
    }).or("coverImage", "avatarImage", "name");

    const { error } = schema.validate(ctx.request.body);
    if (error) {
        ctx.status = 400;
        ctx.body = { error: error.details[0].message };
        return;
    }
    await next();
};

const updateItemMetadataValidation = async (ctx, next) => {
    const traitSchema = Joi.object({
        trait_type: Joi.string().allow(""),
        traitType: Joi.string().allow(""),
        value: Joi.string().allow(""),
    }).unknown(true);

    const schema = Joi.object({
        name: Joi.string().max(256).pattern(SAFE_NAME_PATTERN).optional().allow("").messages({
            "string.pattern.base": "NFT name contains invalid characters. Use only letters, numbers, spaces, hyphens, and underscores.",
        }),
        description: Joi.string().max(5000).optional().allow(""),
        attributes: Joi.array().items(traitSchema).optional(),
        walletType: Joi.string().valid("zelf", "external").required(),
        owner: Joi.string().required(),
        proof: Joi.string().optional(),
        faceBase64: Joi.string().optional(),
        password: Joi.string().optional(),
        signature: Joi.string().required(),
        message: Joi.string().required(),
    })
        .or("name", "description", "attributes")
        .unknown(false);

    const { error } = schema.validate(ctx.request.body);
    if (error) {
        ctx.status = 400;
        ctx.body = { error: error.details[0].message };
        return;
    }
    await next();
};

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

/**
 * Validate the uploaded file:
 *  - A file must be present
 *  - MIME type must be an allowed image format
 *  - The original filename must not contain special characters that break IPFS/Pinata paths or Koa routes
 */
const uploadValidation = async (ctx, next) => {
    const file = ctx.request.files ? ctx.request.files.file : null;

    if (!file) {
        ctx.status = 400;
        ctx.body = { error: "No file uploaded." };
        return;
    }

    const mime = file.mimetype || file.type || "";
    if (!ALLOWED_MIME_TYPES.includes(mime)) {
        ctx.status = 415;
        ctx.body = { error: `Unsupported file type "${mime}". Allowed: jpeg, png, gif, webp.` };
        return;
    }

    const filename = file.originalFilename || file.name || "";
    if (filename && SAFE_NAME_PATTERN && !SAFE_NAME_PATTERN.test(filename.replace(/\.[^.]+$/, ""))) {
        ctx.status = 400;
        ctx.body = {
            error: "File name contains invalid characters. Use only letters, numbers, spaces, hyphens, and underscores.",
        };
        return;
    }

    await next();
};

const rejectListParam = (ctx, code, param) => {
    ctx.status = 400;
    ctx.body = { success: false, error: code, code, ...(param ? { param } : {}) };
};

const assertOptionalQueryStrings = (ctx, names) => {
    const query = ctx.request.query || {};

    for (const name of names) {
        const value = query[name];
        if (value === undefined || value === null || value === "") continue;
        if (typeof value !== "string") {
            rejectListParam(ctx, "INVALID_PARAM", name);
            return false;
        }
    }

    return true;
};

const listCollectionsValidation = async (ctx, next) => {
    if (!assertOptionalQueryStrings(ctx, ["owner", "contractAddress", "limit"])) return;
    await next();
};

const listItemsValidation = async (ctx, next) => {
    if (!assertOptionalQueryStrings(ctx, ["owner", "collection", "limit"])) return;
    await next();
};

const collectionItemsValidation = async (ctx, next) => {
    const id = ctx.params ? ctx.params.id : undefined;

    if (id === undefined || id === null || id === "") return rejectListParam(ctx, "MISSING_REQUIRED_PARAM", "id");
    if (typeof id !== "string") return rejectListParam(ctx, "INVALID_PARAM", "id");
    if (!assertOptionalQueryStrings(ctx, ["owner", "limit"])) return;

    await next();
};

const itemByQueryValidation = async (ctx, next) => {
    const cid = ctx.request.query ? ctx.request.query.cid : undefined;

    if (cid === undefined || cid === null || cid === "") return rejectListParam(ctx, "MISSING_REQUIRED_PARAM", "cid");
    if (typeof cid !== "string") return rejectListParam(ctx, "INVALID_PARAM", "cid");

    await next();
};

const itemByIdValidation = async (ctx, next) => {
    const id = ctx.params ? ctx.params.id : undefined;

    if (id === undefined || id === null || id === "") return rejectListParam(ctx, "MISSING_REQUIRED_PARAM", "id");
    if (typeof id !== "string") return rejectListParam(ctx, "INVALID_PARAM", "id");

    await next();
};

const searchCollectionsValidation = async (ctx, next) => {
    const q = ctx.request.query ? ctx.request.query.q : undefined;

    if (q === undefined || q === null || q === "") return rejectListParam(ctx, "MISSING_REQUIRED_PARAM", "q");
    if (typeof q !== "string" || q.trim().length < 2) return rejectListParam(ctx, "INVALID_PARAM", "q");

    await next();
};

module.exports = {
    createCollectionValidation,
    createNFTValidation,
    mintNFTValidation,
    updateTokenIdValidation,
    deleteCollectionValidation,
    deleteItemValidation,
    updateCollectionValidation,
    updateItemMetadataValidation,
    uploadValidation,
    listCollectionsValidation,
    listItemsValidation,
    collectionItemsValidation,
    itemByQueryValidation,
    itemByIdValidation,
    searchCollectionsValidation,
};
