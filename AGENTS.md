# AGENTS.md

## Backend guidance skills

Operational and workflow-specific guidance lives in:

-   `.cursor/skills/backend-agent-runbook/SKILL.md`
-   `.cursor/skills/backend-patterns/SKILL.md`
-   `.cursor/skills/add-repository-feature/SKILL.md`
-   `.cursor/skills/integration-test-playbook/SKILL.md`

Update those files when commands, ports, route wiring, or testing workflows change.

## Services

This is a Koa backend API with MongoDB, Mongoose, and JWT-protected routes.

-   Start the API with `npm start`.
-   `Core/config.js` falls back to port `3000`, but `.env.example` sets `PORT=3003`. Prefer running locally with an explicit `PORT` instead of relying on fallbacks.
-   Copy `.env.example` to `.env` and provide a working `MONGODB_URI` before running the server.
-   Public API documentation examples use `https://v4.zelf.world`, including Tags, v3.6 surfaces, and Zelf ID (`/api/zelf-ids`). Localhost URLs are for testing only.

## Tests

-   Use Node `24` and local MongoDB, following `tests/README.md`.
-   This repo follows a strict no-mocking policy for backend tests.
-   Integration tests expect a live server, usually bootstrap auth with `POST /api/sessions`, then call protected APIs with `Authorization: Bearer <token>` and `Origin: https://test.example.com`.
-   Test commands live in `package.json`, including `test:unit`, `test:integration`, `test:e2e`, and focused scripts such as `test:lease` and `test:search-tag`.
-   Some older tests still default to mixed fallback ports (`3000` or `3050`). When running tests, export `PORT` explicitly and start the server on the same port to avoid mismatches.

## Architecture

-   `server.js` loads unprotected routes first, then applies `koa-jwt`, then loads protected routes.
-   Register new endpoints through `Routes/unprotected-repositories.js` or `Routes/protected-repositories.js`; adding a repository route file alone is not enough.
-   Most backend work follows the repository pattern under `Repositories/<Feature>/`: routes, controllers, modules, middlewares, and models.
-   `/api/zelf-ids` is owned by `Repositories/ZelfID/` and is served on `https://v4.zelf.world` (same host as ZelfEncrypt v4, `ZELF_PROOF_V4_URL`, path `/zelf-v4`). `/api/tags` stays on Tags + ZelfEncrypt 3.1.6 (`https://v4.zelf.world` + `/zelf`).
-   Raw encrypt APIs: `/api/zelf-proof` → 3.1.6 at `https://v4.zelf.world/zelf`; `/api/human-authn` → v4 at `https://v4.zelf.world/zelf-v4`.
-   Upgrade 3.1.6 → v4: `POST /api/human-authn/upgrade` (402) and `POST /api/jwt/human-authn/upgrade` (dev JWT). Koa calls `https://v4.zelf.world/zelf-v4/upgrade` (SenseCrypt `/refresh-senseprint-face`).
-   v4 Face Certificates: `https://v4.zelf.world` has Face PKI (`pki_private_key`) only. Proofs stay unsigned so Android/iOS can encrypt/decrypt offline. Do not embed `ISSUERS_PUBLIC_KEY` on ZNS or Zelf ID APKs. Koa: `/api/face-certificates` (402) and `/api/my-face-certificates` (JWT). Root cert: `GET /api/face-certificates/root-certificate` or `GET https://v4.zelf.world/root-certificate`. ZelfEncrypt 3.1.6 stays unsigned.
-   zSend (`Repositories/ZSend/`) is the encrypt-to-someone-else product on Face Certificates: `/api/zsend` (directory lookup) and `/api/my-zsend` (publish, send, open), both JWT via `Routes/protected-repositories.js`. Purpose ids are `zsend:<tagName>` for files and `zmail:<tagName>` for messages; clients read them from `GET /api/zsend/purpose-id` instead of hardcoding. Certificate PEMs live in Mongo, not tag `publicData` (Pinata caps keyvalues at 9 × 250 chars). Envelopes store only a Face-Certificate-wrapped content key plus an AES-GCM-256 pointer — never plaintext or a raw key. See `Repositories/ZSend/README.md` and `Repositories/ZSend/CLIENT.md`.
-   Hardhat / Solidity for ERC-8004 lives in `contracts/` (own `package.json`). Install with `npm run contracts:install`. It is not part of the Koa API dependency tree.

## Push for received transfers

-   `Repositories/TxNotifications/`: `POST /api/tx-notifications/devices` and `DELETE /api/tx-notifications/devices/:pushSubscriptionId` (JWT, `Routes/protected-repositories.js`). Registration is signed with the wallet's EVM key (EIP-191, `modules/registration-signature.util.js`); only a SHA-256 of the device secret is stored.
-   The watcher that polls chains and calls OneSignal is its own process: `npm run tx-watcher` (`--once`, `--dry-run`). Never start it inside the API: `V4` runs in pm2 cluster mode. One pm2 fork instance; a second copy idles on the Mongo lease (`TxWatcherLeases`).
-   Env: `ONESIGNAL_APP_ID`, `ONESIGNAL_APP_API_KEY` (IP-allowlisted to the server), optional `TX_WATCHER_*` (see `.env.example`). Only curated tokens are announced (`modules/tokens.js`).
-   Tests: `TX_NOTIFICATIONS_TEST_MONGO_URI=mongodb://127.0.0.1:27017 npm run test:tx-notifications` (unit tests use recorded mainnet fixtures in `tests/fixtures/tx-notifications/`).

## Vault Legacy demo mode

-   Demo wills: `LEGACY_DEMO_MODE=true`, per-vault `isDemo` on `VaultLegacy` Mongo records, fixed `LEGACY_DEMO_LAWYER_ADDRESS`.
-   Never enable demo mode on production `v4.zelf.world`.
-   Cron: `node Repositories/VaultLegacy/check-vaults.js` (auto-confirms succession for demo vaults after liveness expiry).
-   Mobile contract: `Repositories/VaultLegacy/DEMO-MOBILE.md`.

## Development-only JWT encrypt mirrors

-   `POST /api/jwt/zelf-proof/{encrypt,encrypt-qr-code,decrypt,preview}` and `POST /api/jwt/human-authn/{encrypt,encrypt-qr-code,decrypt,preview,upgrade}` reuse the paid controllers but skip the ZNS payment gate.
-   Registered in `Routes/protected-repositories.js`, so `koa-jwt` requires `Authorization: Bearer <token>`.
-   Each route file returns immediately unless `config.env === "development"`. Never enable these on production `v4.zelf.world`.
-   Focused checks: `PORT=3003 npm run test:jwt-dev` and `PORT=3003 npm run test:encrypt-compat` against a live server started with the same `PORT`.

## Documentation

-   Backend source docs live in this repo (`README.md`, `tests/README.md`, `security/`, feature notes).
-   Public API docs belong in `zelf-documentation/docs/api/`.
-   Zelf ID v4 plans (6+ chars lease as `free`; `.hold` only for 5 chars or fewer), and payment routes: `zelf-documentation` Changelog (`2026-08-31-zelf-id-migration-v4`) and `docs/api/zelf-ids/unit-tests.md`. Source notes: `Repositories/ZelfID/README.md`.
