const config = require("../../../Core/config");
const Controller = require("../controllers/blockdag-nft.controller");
const Middleware = require("../middlewares/blockdag-nft.middleware");

const base = "/blockdag/nft";

module.exports = (server) => {
    const PATH = config.basePath(base);

    // Public: List Collections & Items
    server.get(`${PATH}/collections/search`, Middleware.searchCollectionsValidation, Controller.searchCollections);
    server.get(`${PATH}/collections`, Middleware.listCollectionsValidation, Controller.getCollections);
    server.get(`${PATH}/items`, Middleware.listItemsValidation, Controller.getItems);
    server.get(`${PATH}/collection/:id/items`, Middleware.collectionItemsValidation, Controller.getCollectionItems);

    // Public: Get a single NFT item — by ?cid= (query) or by path param (CID or Pinata ID)
    server.get(`${PATH}/item`, Middleware.itemByQueryValidation, Controller.getItemByQuery);

    server.get(`${PATH}/item/:id`, Middleware.itemByIdValidation, Controller.getItem);

    // Public: Get the official default Zelf Name Service collection address
    server.get(`${PATH}/default-collection`, Controller.getDefaultCollection);

};
