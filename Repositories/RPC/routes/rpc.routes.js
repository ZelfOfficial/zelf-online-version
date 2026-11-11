const config = require("../../../Core/config");
const Controller = require("../controllers/rpc.controller");
const Middleware = require("../middlewares/rpc.middleware");

const base = "/rpc";

module.exports = (server) => {
    const PATH = config.basePath(base);

    server.get(`${PATH}/chains`, Controller.getChains);
    server.post(`${PATH}/request`, Middleware.requestValidation, Controller.request);
    // POST /api/rpc/:chainKey — JSON-RPC proxy per chain.
    // :chainKey matches a key in config.rpc.chains:
    //
    // EVM chains:
    //   /api/rpc/ethereum    (chainId 1)
    //   /api/rpc/avalanche   (chainId 43114)
    //   /api/rpc/polygon     (chainId 137)
    //   /api/rpc/bsc         (chainId 56)
    //   /api/rpc/arbitrum    (chainId 42161)
    //   /api/rpc/optimism    (chainId 10)
    //   /api/rpc/base        (chainId 8453)
    //
    // Non-EVM (not proxied here — handled by dedicated Repositories):
    //   Solana   → Repositories/Solana  (config.solana.rpcUrl)
    //   Stellar  → Repositories/Stellar
    //   Sui      → Repositories/Walrus
    server.post(`${PATH}/:chainKey`, Middleware.jsonRpcValidation, Controller.requestJsonRpc);
};
