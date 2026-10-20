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
