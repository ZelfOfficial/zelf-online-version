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
-   Public API documentation examples should use `https://v3.zelf.world`. Localhost URLs are for testing only.

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

## Vault Legacy

-   Feature root: `Repositories/VaultLegacy/`.
-   Liveness cron (grace-period and lawyer emails only): `node Repositories/VaultLegacy/check-vaults.js`.
-   Former demo endpoints under `/api/vault-legacy/demo/*` respond with HTTP 410.

## Documentation

-   Backend source docs live in this repo (`README.md`, `tests/README.md`, `security/`, feature notes).
-   Public API docs belong in `zelf-documentation/docs/api/`.
