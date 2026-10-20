# Face security (anti-deepfake)

Shared lockout, proof-of-work, capture nonces, and request body whitelisting for endpoints that accept `faceBase64`.

## Client flow

1. `POST /api/face/nonce` with `{ action }` (optional legacy `identifier`, **ignored for binding**) → `{ nonce, expiresAt, bindingIdentifier, pow? }`. The server resolves `bindingIdentifier` from the JWT (tag@domain, etc.) with the same rules as the face gate.
2. Face endpoints include `faceNonce` and, when required, `pow: { challengeId, solution }` (challenge fields are stored server-side by `challengeId`).
3. PoW: `SHA-256(salt + solution)` must have at least `difficulty` **leading zero bits** in the hex digest (`difficultyMode: leading_zero_bits`). Default **16** bits at the first PoW threshold (`powAfterFailures`, default 2), then **+1 bit per two** additional identity failures, capped at **19**.
4. `428` + `pow_required` when PoW is mandatory; `429` + `face_locked` + `retryAfter` when locked out; `409` + `face_replay_detected` when the same face capture is reused.

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

With `FACE_BODY_WHITELIST_ENABLED=true` (default), only **`STRIPPED_SERVER_ONLY_FIELDS`** are removed (`removePGP`, `tolerance`, `requireLiveness`, `verifierKey`, etc.). All other client fields pass through.

`FACE_BODY_STRICT_WHITELIST=true` enables the per-action allow-list (off by default). When strict is off, keys that strict mode would drop are **kept** and logged as `strict whitelist would drop keys`.

Legacy mappings: `securePassword` → `password`; `newTagName` → `tagName` when `tagName` is missing (tags lease-recovery extension payload).

## Lockout scopes

- **Identity** (`action:tag@domain` or JWT `tagName@domain` / `session:<id>` when the body has no tag) — primary lockout and PoW threshold. No shared `unknown` bucket.
- **Device** — JWT `session` + identity composite (not global session-only).
- **IP** — metrics only unless `FACE_ATTEMPT_IP_LOCKOUT_ENABLED=true` (default `false` for shared NAT).
