const config = require("../../../Core/config");
const Controller = require("../controllers/blockdag-nft.controller");
const Middleware = require("../middlewares/blockdag-nft.middleware");
const FaceMiddleware = require("../../Face/middlewares/face.middleware");

const base = "/blockdag/nft";

/**
 * All routes in this file are registered from Routes/protected-repositories.js — i.e. AFTER koa-jwt in server.js.
 * Every handler therefore requires a valid JWT session (`Authorization: Bearer <token>` from POST /api/sessions).
 * Mutating routes also require wallet proof in the body (signature + message, etc.).
 */
module.exports = (server) => {
    const PATH = config.basePath(base);

    // Protected: Upload, Create Collection & Item
    server.post(`${PATH}/upload`, Middleware.uploadValidation, Controller.upload);

    server.post(`${PATH}/collection`, Middleware.createCollectionValidation, FaceMiddleware.gateIfFace("blockdag-zelf"), Controller.createCollection);
    
    server.patch(`${PATH}/collection/:id`, Middleware.updateCollectionValidation, FaceMiddleware.gateIfFace("blockdag-zelf"), Controller.updateCollection);
    
    server.post(`${PATH}/item`, Middleware.createNFTValidation, FaceMiddleware.gateIfFace("blockdag-zelf"), Controller.createNFT);
    // Protected: Server-side mint for shared/owner-only collections (uses deployer key)
    server.post(`${PATH}/item/mint`, Middleware.mintNFTValidation, FaceMiddleware.gateIfFace("blockdag-zelf"), Controller.mintNFT);
    server.patch(`${PATH}/item/:id/token`, Middleware.updateTokenIdValidation, FaceMiddleware.gateIfFace("blockdag-zelf"), Controller.updateTokenId);
    // JWT session required (this router is not on unprotected-repositories). Body still needs EIP-191 owner signature.
    server.patch(`${PATH}/item/:id/metadata`, Middleware.updateItemMetadataValidation, FaceMiddleware.gateIfFace("blockdag-zelf"), Controller.updateItemMetadata);

    server.post(`${PATH}/collection/:id/delete`, Middleware.deleteCollectionValidation, FaceMiddleware.gateIfFace("blockdag-zelf"), Controller.deleteCollection);

    server.post(`${PATH}/item/:id/delete`, Middleware.deleteItemValidation, FaceMiddleware.gateIfFace("blockdag-zelf"), Controller.deleteItem);

    // Silent background repair: re-pins content from broken dev gateway to production account.
    // JWT session required; no wallet signature (content already validated as blockdag_nft_item).
    server.post(`${PATH}/item/:id/repair-gateway`, Controller.repairGatewayUrl);
};
