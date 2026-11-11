# Secure password share contract

Base path: `/api/password-shares` on the v4 API (`https://v4.zelf.world`).

The extension encrypts the item with AES-256-GCM and a random 256-bit key. It uploads ciphertext only. The key is the URL fragment on the landing page and is never a request field, a response field, or a stored field.

Landing link shape:

```text
https://zelf.world/share/<id>#<base64url key>
```

`zelf.world` is `config.landingUrl` in production. Development default is `http://localhost:3009` (`LANDING_URL`). The browser does not send the fragment. The landing page calls the public routes below and decrypts locally.

CORS is app-wide `Access-Control-Allow-Origin: *` (`server.js`). `https://zelf.world` and `http://localhost:3009` can call the public routes without cookies. Do not send `credentials: "include"`.

Password-share responses also send `Access-Control-Expose-Headers: Retry-After`. That header is limited to these routes. A cross-origin `429` includes `Retry-After` (seconds), and the landing page can read it for the countdown. App-wide CORS does not expose it.

Success bodies are the objects below. They are not wrapped in `{ data }`.

Error bodies are `{ "code": "<UPPER_SNAKE>", "message": "<same code>" }` plus the HTTP status in the table. A missing or invalid session on an owner route is the existing JWT 401: `{ "error": "Protected resource, use Authorization header to get access" }`.

## Owner routes

Require `Authorization: Bearer <token>` from `POST /api/sessions`. The owner is that session's `identifier`. A later session with the same `identifier` can list and revoke. `tagName` is stored for display and is not the ownership key.

### `POST /api/password-shares`

```json
{
  "ciphertext": "<standard base64>",
  "iv": "<standard base64 of 12 bytes>",
  "version": 1,
  "expiresIn": 3600,
  "maxViews": 1,
  "label": "optional hint"
}
```

- `expiresIn` is one of `3600`, `86400`, `604800`, `2592000` (seconds). Integers only.
- `maxViews` is an integer from 1 to 10. Omitted means 1.
- `label` is optional, trimmed, max 60 characters, no ASCII control characters. Empty or omitted is stored as no label.
- Decoded ciphertext is 1 to 16384 bytes. The server stores canonical standard base64 (with padding).
- `version` must be the number `1`.

Response `200`:

```json
{ "id": "<base64url, 256 bits>", "expiresAt": "<ISO-8601>", "maxViews": 1 }
```

`expiresAt` is server time plus `expiresIn`. There is no per-plan cap yet. The hook is `assertOwnerMayCreateShare` in `modules/password-share.module.js`.

### `GET /api/password-shares`

Response `200`:

```json
{
  "shares": [
    {
      "id": "<id>",
      "label": "optional",
      "createdAt": "<ISO-8601>",
      "expiresAt": "<ISO-8601>",
      "remainingViews": 1,
      "maxViews": 1
    }
  ]
}
```

Active shares only (not expired, revoked, or consumed). Newest first. At most 100. No ciphertext. `label` is omitted when the share has none.

### `DELETE /api/password-shares/:id`

Owner only. Purges ciphertext and IV. Response `200`:

```json
{ "id": "<id>", "revoked": true }
```

Repeating the delete for the same owner is `200` with the same body.

## Public routes

No session. These do not accept or return the key.

### `GET /api/password-shares/:id`

Does not consume a view. Response `200`:

```json
{
  "id": "<id>",
  "expiresAt": "<ISO-8601>",
  "remainingViews": 1,
  "label": "optional"
}
```

`label` is omitted when absent. Ciphertext is not selected and is not returned.

### `POST /api/password-shares/:id/reveal`

Atomically consumes one view. Response `200`:

```json
{
  "ciphertext": "<standard base64>",
  "iv": "<standard base64>",
  "version": 1,
  "expiresAt": "<ISO-8601>",
  "remainingViews": 0
}
```

When `remainingViews` reaches 0 the ciphertext and IV are deleted. A second concurrent reveal of a 1-view share receives `404 SHARE_NOT_FOUND`. Only one caller receives the ciphertext.

## Error codes

| HTTP | code | When |
| --- | --- | --- |
| 400 | `INVALID_CIPHERTEXT` | Missing, empty, or not standard base64 |
| 400 | `INVALID_IV` | Missing or not a 12-byte standard-base64 IV |
| 400 | `INVALID_VERSION` | `version` is not the number `1` |
| 400 | `INVALID_EXPIRATION` | `expiresIn` is not one of the four allowed integers |
| 400 | `INVALID_MAX_VIEWS` | `maxViews` is not an integer from 1 to 10 |
| 400 | `INVALID_LABEL` | Label is not a string, is longer than 60, or contains control characters |
| 400 | `SHARE_KEY_NOT_ACCEPTED` | Body includes `key`, `password`, `plaintext`, `secret`, `dek`, `contentKey`, `aesKey`, or `encryptionKey` |
| 401 | `SHARE_SESSION_REQUIRED` | Owner route reached with a session that has no `identifier` |
| 403 | `SHARE_FORBIDDEN` | Authenticated delete of a share owned by another `identifier` |
| 404 | `SHARE_NOT_FOUND` | Unknown id, revoked, or consumed. These cases use the same code |
| 410 | `SHARE_EXPIRED` | The row is past `expiresAt` and has not been reaped. Revoked rows stay `404` |
| 413 | `SHARE_TOO_LARGE` | Decoded ciphertext is larger than 16384 bytes |
| 429 | `PASSWORD_SHARE_RATE_LIMITED` | Create, metadata, or reveal exceeded the per-minute cap. `Retry-After` is set and listed in `Access-Control-Expose-Headers` |
| 500 | `SHARE_UNAVAILABLE` | The database write or read failed |

Rate limits (per minute, in-memory, override with env): create `PASSWORD_SHARE_CREATE_RATE_LIMIT_PER_MINUTE` (default 30, keyed by session `identifier`), metadata `PASSWORD_SHARE_METADATA_RATE_LIMIT_PER_MINUTE` (default 60, per IP), reveal `PASSWORD_SHARE_REVEAL_RATE_LIMIT_PER_MINUTE` (default 20, per IP).

Request bodies and ciphertext are not written to logs on these routes. The raw request body copy is discarded before the handler runs.
