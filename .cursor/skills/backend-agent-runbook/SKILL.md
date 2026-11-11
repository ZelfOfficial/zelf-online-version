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

### BlockDAG and NFT flows

- Check `Repositories/BlockDAG/`, especially the public/protected route split and the smart-contract folder under `Repositories/BlockDAG/smart-contracts/`.
- Relevant maintenance scripts include `npm run repair:blockdag-nft-index`.

### Vault Legacy (inheritance plans)

- Feature root: `Repositories/VaultLegacy/`.
- Liveness cron (grace-period and lawyer emails only): `node Repositories/VaultLegacy/check-vaults.js`.
- Former demo endpoints under `/api/vault-legacy/demo/*` respond with HTTP 410.

### Docs work

- Public API docs belong in `zelf-documentation/docs/api/`.
- Public examples must use `https://v3.zelf.world`, not localhost.

## Maintenance

- When commands, ports, or environment expectations change, update this file and mirror durable high-signal facts in `AGENTS.md`.
