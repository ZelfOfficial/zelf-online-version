---
name: backend-agent-runbook
description: Run, configure, and verify the Zelf backend API. Use when working on backend setup, local execution, tests, Mongo requirements, route verification, or docs-related backend workflows.
---

# Backend Agent Runbook

Use this skill for practical backend operations in `zelf`.

## Quick start

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env` and provide at least `MONGODB_URI`, secrets, and any service keys needed for your area.
3. Start MongoDB locally.
4. Start the API with `npm start`.

## Port guidance

- `Core/config.js` falls back to `3000`.
- `.env.example` sets `PORT=3003`.
- Several older tests still default to `3000` or `3050`.
- Prefer an explicit `PORT` whenever you run the API or tests so the server and test client agree.

Recommended default local workflow:

```bash
PORT=3003 npm start
```

For a test file that expects another port, export that same `PORT` before starting the server and running the test.

## Core commands

- Dev server: `npm start`
- Unit tests: `npm run test:unit`
- Integration tests: `npm run test:integration`
- End-to-end tests: `npm run test:e2e`
- Focused integration checks: `npm run test:lease`, `npm run test:search-tag`, `npm run test:authentication`
- Ops scripts: `npm run audit:ipfs-pay-balances`, `npm run repair:blockdag-nft-index`, `npm run deploy:checkout-avax`

## Test requirements

- Use Node `24` and local MongoDB, following `tests/README.md`.
- The backend follows a strict no-mocking policy.
- Integration tests hit a live server, usually create a session via `/api/sessions`, then call protected routes with `Authorization: Bearer <token>` and `Origin: https://test.example.com`.
- The dedicated test database is `zelf_testing`.

## By area

### General API work

- `server.js` controls startup order, JWT handling, and protected vs unprotected route mounting.
- Route registration lives in `Routes/unprotected-repositories.js` and `Routes/protected-repositories.js`.

### Tags, search, and lease flows

- Check `Repositories/Tags/` plus related integration tests under `tests/integration/`.
- Use `config/0012589021.json` when a biometric payload is required in tests.

### ZelfID (online, ZelfEncrypt v4)

- `/api/zelf-ids` is owned by `Repositories/ZelfID/` (not a Tags alias). Public host is `https://v4.zelf.world` (for example `GET https://v4.zelf.world/api/zelf-ids/search`).
- Online encrypt/decrypt/preview go to `ZELF_PROOF_V4_URL` (default `https://v4.zelf.world`) + `ZELF_PROOF_V4_PATH_PREFIX` (default `/zelf-v4`).
- `/api/tags` stays on `ZELF_PROOF_URL` + `/zelf` (ZelfEncrypt 3.1.6 on `https://v4.zelf.world`). Tags offline lease stays `POST /api/tags/lease-offline`. Zelf ID offline lease is `POST /api/zelf-ids/lease-offline` (v4 `previewHumanAuthn`).
- Raw encrypt/decrypt/preview: `/api/zelf-proof` → 3.1.6 on v3; `/api/human-authn` → v4 on `https://v4.zelf.world` (`Repositories/HumanAuthn/`).
- Upgrade 3.1.6 → v4: `POST /api/human-authn/upgrade` (402) and `POST /api/jwt/human-authn/upgrade` (dev JWT). Upstream `https://v4.zelf.world/zelf-v4/upgrade`. Focused check: `npm run test:encrypt-compat`.
- Development-only JWT mirrors (no ZNS payment): `/api/jwt/zelf-proof` and `/api/jwt/human-authn`. Gated on `config.env === "development"`. Focused check: `npm run test:jwt-dev`. Never enable on `v4.zelf.world`.
- v4 Face Certificates: `https://v4.zelf.world` has Face PKI (`pki_private_key`) only. Proofs stay unsigned so Android/iOS can encrypt/decrypt offline. Do not embed `ISSUERS_PUBLIC_KEY` on ZNS or Zelf ID APKs. Koa: `/api/face-certificates` (402) and `/api/my-face-certificates` (JWT). Root cert: `GET /api/face-certificates/root-certificate`. Focused check: `npm run test:face-certificates`. 3.1.6 stays unsigned.
- Focused check: `npm run test:zelf-ids`.
- Cross-platform availability regression: `npm run test:tag-registration` (Node 24; read-only real provider failure, no API server/Mongo required).

### zSend (encrypt to someone else)

- `Repositories/ZSend/` builds on Face Certificates: `/api/zsend` (directory lookup) and `/api/my-zsend` (publish, send, open). Both JWT, registered in `Routes/protected-repositories.js`.
- Purpose ids: `zsend:<tagName>` for files, `zmail:<tagName>` for messages. Read them from `GET /api/zsend/purpose-id`; do not hardcode the format.
- Certificate PEMs live in Mongo (`models/zsend-certificate.model.js`), not tag `publicData` — Pinata caps metadata at 9 keyvalues of 250 chars.
- Envelopes hold a Face-Certificate-wrapped content key plus AES-GCM-256 parameters and a ciphertext pointer. Never accept plaintext or a raw content key.
- Recipient authorization comes from the directory, not the JWT `tagName`: `POST /api/sessions` accepts any `tagName` unproven.
- Focused check: `PORT=3003 npm run test:zsend`. Client contract: `Repositories/ZSend/CLIENT.md`.

### BlockDAG and NFT flows

- Check `Repositories/BlockDAG/`, especially the public/protected route split and the smart-contract folder under `Repositories/BlockDAG/smart-contracts/`.
- Relevant maintenance scripts include `npm run repair:blockdag-nft-index`.

### Solidity / Hardhat

- Root Koa API does not install Hardhat. Use `contracts/` (`npm run contracts:install`, `npm run contracts:compile`).
- BlockDAG NFT contracts: `Repositories/BlockDAG/smart-contracts/`. Avalanche ZelfKey NFT: `Avalanche/`.

### Push for received transfers (TxNotifications)

- Feature root: `Repositories/TxNotifications/` (device routes, models, chain adapters, OneSignal sender, watcher).
- Watcher: `npm run tx-watcher` (loop), `npm run tx-watcher -- --once --dry-run` (one cycle, no OneSignal call). Runs as its own pm2 app in fork mode, never inside the clustered API.
- OneSignal key is IP-allowlisted to production; local runs cannot send pushes. Use `--dry-run` and read `TxPushLogs`.
- Focused check: `TX_NOTIFICATIONS_TEST_MONGO_URI=mongodb://127.0.0.1:27017 npm run test:tx-notifications` (unit + one Mongo-backed suite; no API server needed).

### Vault Legacy (inheritance plans)

- Feature root: `Repositories/VaultLegacy/`.
- Demo mode env: `LEGACY_DEMO_MODE`, `LEGACY_DEMO_LAWYER_ADDRESS` (see `.env.example`). Do not enable on production.
- Heartbeat cron: `node Repositories/VaultLegacy/check-vaults.js`.
- Mobile demo contract: `Repositories/VaultLegacy/DEMO-MOBILE.md`.

### Docs work

- Public API docs belong in `zelf-documentation/docs/api/`.
- Public examples use `https://v4.zelf.world` for Tags, v3.6 surfaces, and Zelf ID (`/api/zelf-ids`). Do not use localhost in published docs.

## Maintenance

- When commands, ports, or environment expectations change, update this file and mirror durable high-signal facts in `AGENTS.md`.
