const config = require("../../../Core/config");
const Controller = require("../controllers/rpc.controller");
const RestController = require("../controllers/rpc-rest.controller");
const Middleware = require("../middlewares/rpc.middleware");
const { requireAllowedProtectedRpcOrigin } = require("../middlewares/protected-rpc-origin.middleware");

const base = "/protected/rpc";

/**
 * Wallet extension RPC contract (session JWT + optional Origin allowlist).
 *
 * Auth: `Authorization: Bearer <token>` from `POST /api/sessions`.
 * The extension already mints that session from a device fingerprint before
 * unlock (`AuthService.checkAccessToken`), including onboarding balance reads.
 * There is no anonymous RPC route.
 *
 * Origin: enforced only when `PROTECTED_RPC_ALLOWED_ORIGINS` or
 * `PROTECTED_RPC_CHROME_EXTENSION_IDS` is set.
 *
 * JSON-RPC (single object or a batch of at most `RPC_PROXY_MAX_BATCH`, default 10):
 *   POST /api/protected/rpc/:chainKey
 *   Body: {"jsonrpc":"2.0","id":1,"method":"...","params":[]}
 *   chainKey: ethereum | ethereum-sepolia (alias sepolia) | polygon | avalanche |
 *             bsc | arbitrum | optimism | base | blockdag | solana
 *   Success: HTTP 200 {"jsonrpc":"2.0","id":1,"result":...}
 *   Policy errors use a JSON-RPC error body. HTTP 401 without a JWT,
 *   413 when the body exceeds RPC_PROXY_MAX_BODY_BYTES (default 256 KiB),
 *   429 with Retry-After when the per-IP or per-user limit is exceeded.
 *   Paid chains return 503 `rpc_upstream_not_configured` until their env URL is set.
 *   Methods are per-chain allowlists. debug_, trace_, subscribe, qn_, alchemy_,
 *   eth_getLogs, and eth_sendTransaction are rejected.
 *
 * Bitcoin Blockbook (`network` is `mainnet` or `testnet`):
 *   GET  /api/protected/rpc/btc/:network/address/:address/utxo
 *        → Blockbook UTXO JSON (value may be a string)
 *   GET  /api/protected/rpc/btc/:network/tx/:txid/hex
 *        → text/plain raw transaction hex
 *   POST /api/protected/rpc/btc/:network/tx
 *        body text/plain hex, or JSON {"hex":"<raw tx>"}
 *        → text/plain txid
 *   GET  /api/protected/rpc/btc/:network/api/v2/address/:address
 *   GET  /api/protected/rpc/btc/:network/api/v2/utxo/:address
 *   GET  /api/protected/rpc/btc/:network/api/v2/tx/:txid
 *   GET  /api/protected/rpc/btc/:network/api/v2/tx-specific/:txid
 *   GET  /api/protected/rpc/btc/:network/api/v2/block/:blockId
 *   GET  /api/protected/rpc/btc/:network/api/v2/block-index/:blockId
 *   POST /api/protected/rpc/btc/:network/api/v2/sendtx
 *        → upstream Blockbook JSON, passed through
 *
 * Stellar Horizon. Set the server URL to this prefix and send the bearer token
 * on every request (`new Horizon.Server(url, { headers: { Authorization } })`):
 *   GET  /api/protected/rpc/stellar
 *   GET  /api/protected/rpc/stellar/fee_stats
 *   GET  /api/protected/rpc/stellar/ledgers?order=asc|desc&limit=1..20&cursor=
 *   GET  /api/protected/rpc/stellar/accounts/:accountId
 *   POST /api/protected/rpc/stellar/transactions
 *        JSON {"tx":"<base64 xdr>"} or form field `tx`
 *        Horizon status and body are passed through (404 account-not-found included).
 *
 * Sui is not a provider-credential proxy. The extension uses public GraphQL.
 * POST /api/rpc/sui (JWT) still translates an allowlisted JSON-RPC subset to GraphQL.
 */
module.exports = (server) => {
    const PATH = config.basePath(base);
    const guard = [requireAllowedProtectedRpcOrigin, Middleware.assertRpcBodyLimit(false)];

    server.get(`${PATH}/chains`, requireAllowedProtectedRpcOrigin, Controller.getExtensionChains);

    server.get(`${PATH}/btc/:network/address/:address/utxo`, ...guard, RestController.bitcoin("utxo"));
    server.get(`${PATH}/btc/:network/tx/:txid/hex`, ...guard, RestController.bitcoin("tx-hex"));
    server.post(`${PATH}/btc/:network/tx`, ...guard, RestController.bitcoin("broadcast"));
    server.get(`${PATH}/btc/:network/api/v2/address/:address`, ...guard, RestController.bitcoin("blockbook-address"));
    server.get(`${PATH}/btc/:network/api/v2/utxo/:address`, ...guard, RestController.bitcoin("blockbook-utxo"));
    server.get(`${PATH}/btc/:network/api/v2/tx/:txid`, ...guard, RestController.bitcoin("blockbook-tx"));
    server.get(`${PATH}/btc/:network/api/v2/tx-specific/:txid`, ...guard, RestController.bitcoin("blockbook-tx-specific"));
    server.get(`${PATH}/btc/:network/api/v2/block/:blockId`, ...guard, RestController.bitcoin("blockbook-block"));
    server.get(`${PATH}/btc/:network/api/v2/block-index/:blockId`, ...guard, RestController.bitcoin("blockbook-block-index"));
    server.post(`${PATH}/btc/:network/api/v2/sendtx`, ...guard, RestController.bitcoin("blockbook-send"));

    server.get(`${PATH}/stellar`, ...guard, RestController.stellar("root"));
    server.get(`${PATH}/stellar/fee_stats`, ...guard, RestController.stellar("fee_stats"));
    server.get(`${PATH}/stellar/ledgers`, ...guard, RestController.stellar("ledgers"));
    server.get(`${PATH}/stellar/accounts/:accountId`, ...guard, RestController.stellar("account"));
    server.post(`${PATH}/stellar/transactions`, ...guard, RestController.stellar("submit"));

    server.post(
        `${PATH}/:chainKey`,
        requireAllowedProtectedRpcOrigin,
        Middleware.assertRpcBodyLimit(true),
        Middleware.jsonRpcValidationExtension,
        Controller.requestExtensionJsonRpc
    );
};
