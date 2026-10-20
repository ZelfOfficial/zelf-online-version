# Face security (anti-deepfake)

Shared lockout, proof-of-work, capture nonces, and request body whitelisting for endpoints that accept `faceBase64`.

## Client flow

1. `POST /api/face/nonce` with `{ action, identifier }` → `{ nonce, expiresAt, pow? }`.
2. Face endpoints include `faceNonce` and, when required, `pow: { challengeId, solution, salt, difficulty, expiresAt, signature }`.
3. `428` + `pow_required` when PoW is mandatory; `429` + `face_locked` + `retryAfter` when locked out.

## Configuration

See `Core/config.js` → `faceSecurity` and `.env.example` (`FACE_*` variables).

PoW HMAC secret: generate on the server with `openssl rand -hex 32` — never commit or log a production value.

## Middleware

```js
const FaceMiddleware = require("../../Face/middlewares/face.middleware");

server.post(`${PATH}/decrypt`, Middleware.decryptValidation, FaceMiddleware.gate("decrypt"), Controller.decryptTag);
```

Use `FaceMiddleware.gateIfFace(action)` when `faceBase64` is optional (BlockDAG zelf wallet flows).

## Body whitelist

Unknown body keys are **stripped silently** (logged server-side), never rejected. Known server-only keys documented in `STRIPPED_SERVER_ONLY_FIELDS` inside `face-body-whitelist.module.js` include: `removePGP`, `tolerance`, `requireLiveness`, `verifierKey`, `referenceFaceBase64`, `livenessDetectionPriorCreation`, and similar upstream overrides.

Legitimate client fields include `password` (PGP-armored), legacy `securePassword` (mapped to `password`), `faceNonce`, `pow`, `masterPassword`, and action-specific fields aligned with route Joi schemas (extension 2.1.56 / mobile / dashboard).

## Lockout scopes

- **Identity** (`action:tag@domain`) — primary lockout and PoW threshold.
- **Device** — JWT `session` + identity composite (not global session-only).
- **IP** — metrics only unless `FACE_ATTEMPT_IP_LOCKOUT_ENABLED=true` (default `false` for shared NAT).
