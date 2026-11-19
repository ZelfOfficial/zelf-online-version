# Owner grant

The mobile apps open a new session every few minutes. A face check stamps only that session, for 10 minutes. Quote calls do not need the stamp. Swap execution, plan limits, and chain activation do. The owner grant lets the app carry the verified owner onto the next session without another face check.

The owner is taken from the grant signature, or from the face check that minted the grant. A `tagName` sent by the client is stored as a claim and is not the owner.

## Store it

After a successful face check, read `data.ownerGrant` and `data.ownerGrantExpiresAt`. Keep `ownerGrant` in secure storage (Android Keystore, iOS Keychain). Replace it when a later face check returns a new one. Delete it on logout and when the user switches wallet.

Do not send `ownerGrant` as `Authorization`. It is not a session token. A request that uses it as a bearer token is rejected with `401` `INVALID_TOKEN_TYPE`.

`ownerGrantExpiresAt` is a Unix timestamp in seconds. After that instant the API rejects the grant with `401` `ERR_OWNER_GRANT_EXPIRED`. The default lifetime is 12 hours (`OWNER_GRANT_TTL`).

## Where it is returned

The field is on the success payload, inside `data` (the same object the app already reads):

| Method | Path |
| --- | --- |
| POST | `/api/zelf-ids/decrypt` |
| POST | `/api/zelf-ids/lease` |
| POST | `/api/tags/decrypt` |
| POST | `/api/tags/lease` |
| POST | `/api/my-wallets/decrypt` |
| POST | `/api/my-wallets/export` |
| POST | `/api/my-wallets/import` |

Example:

```json
{
  "data": {
    "ownerGrant": "<jwt>",
    "ownerGrantExpiresAt": 1763600000
  }
}
```

Other response fields are unchanged. When the face check did not prove an owner, these two fields are absent. Ignore any `ownerGrant` that arrived inside a wallet or tag payload; the API strips that and sets the top-level field only when it minted the grant.

## Send it

`POST /api/sessions` (public, no `Authorization` header).

```json
{
  "identifier": "same-device-id-used-for-the-face-check-session",
  "domain": "zelf",
  "type": "general",
  "isWebExtension": false,
  "tagName": "optional-claim-ignored-for-ownership",
  "ownerGrant": "<jwt>"
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `identifier` | yes | Same string sent when the face-check session was created. The grant is bound to it. |
| `domain` | yes for this API | Must be the domain sealed in the grant. Apps use `zelf`. |
| `ownerGrant` | no | When present and valid, the new session is stamped. When omitted, behavior is unchanged: the session is not verified. |
| `tagName` | no | Still accepted and still only a claim. It does not choose the owner. |
| `type` | no | `createWallet`, `decryptWallet`, `importWallet`, or `general`. |
| `isWebExtension` | no | Unchanged. The extension omits `ownerGrant`. |

Success, grant accepted:

```json
{
  "data": {
    "token": "<session jwt, 10 minutes>",
    "activatedAt": 1763550000,
    "expiresAt": 1763550600,
    "verifiedTagName": "alice.zelf",
    "verifiedUntil": 1763550600
  }
}
```

`token`, `activatedAt`, and `expiresAt` are the same fields as before. `verifiedTagName` and `verifiedUntil` are added only when the grant was accepted. `verifiedUntil` is Unix seconds. The stamp lasts 10 minutes, the same window as a face check on that session. Create another session with the same grant when that window runs out. The grant itself remains valid until `ownerGrantExpiresAt`.

Success, no grant (extension and older apps):

```json
{
  "data": {
    "token": "<session jwt>",
    "activatedAt": 1763550000,
    "expiresAt": 1763550600
  }
}
```

Use `data.token` as `Authorization: Bearer <token>` on later calls, the same way as today.

## What the grant contains

The app can read these claims to decide when to drop the grant. The server checks the signature; the app does not need to.

| Claim | Meaning |
| --- | --- |
| `typ` | `owner_grant` |
| `sub` | Verified owner, `name.domain` (for example `alice.zelf`) |
| `dom` | Domain (`zelf`) |
| `sid_ident` | `identifier` of the session that passed the face check |
| `exp` | Unix seconds. Same instant as `ownerGrantExpiresAt` |

Changing `sub`, `sid_ident`, or any other byte makes the signature fail.

## Errors

Both are HTTP `401`. `error` and `code` are the same `UPPER_SNAKE` value. No session is created.

| `code` | When |
| --- | --- |
| `ERR_OWNER_GRANT_EXPIRED` | `exp` is in the past. |
| `ERR_OWNER_GRANT_INVALID` | Signature, `typ`, owner, or device binding does not check out. This includes a grant for another `identifier`, another `domain`, a tampered token, a token signed with a previous secret, and a session JWT sent in `ownerGrant`. |

```json
{
  "error": "ERR_OWNER_GRANT_INVALID",
  "code": "ERR_OWNER_GRANT_INVALID",
  "message": "Owner grant is invalid"
}
```

```json
{
  "error": "ERR_OWNER_GRANT_EXPIRED",
  "code": "ERR_OWNER_GRANT_EXPIRED",
  "message": "Owner grant has expired"
}
```

A blank `ownerGrant` is treated as omitted. The session is created unverified.

## Routes that use the stamp

These keep their current checks. A session stamped from a grant passes them for those 10 minutes. A session without the stamp still fails.

| Method | Path | Rejection without a current stamp |
| --- | --- | --- |
| POST | `/api/lifi/execute-advanced-step-transaction` | `401` `ERR_ZELF_IDENTITY_REQUIRED` |
| GET | `/api/zelf-keys/limits` | `403` `ERR_SESSION_NOT_VERIFIED` |
| GET | `/api/zelf-ids/limits` | `403` `ERR_SESSION_NOT_VERIFIED` |
| GET | `/api/zelf-ids/chains` | `403` `ERR_SESSION_NOT_VERIFIED` |
| POST | `/api/zelf-ids/chains/activate` | `403` `ERR_SESSION_NOT_VERIFIED` |

`GET /api/lifi/quote` does not use the stamp and does not count toward the monthly swap limit. A successful `POST /api/lifi/execute-advanced-step-transaction` on a stamped session counts toward that Zelf ID's monthly plan limit, the same as a session stamped by a face check.

The counted owner is the grant's `sub`, not the `tagName` claim. A grant for `alice.zelf` cannot be turned into a session for someone else.

## Server configuration

| Variable | Meaning |
| --- | --- |
| `OWNER_GRANT_SECRET` | Dedicated HMAC secret. Rotating it revokes every outstanding owner grant. Session tokens stay on `CONNECTION_KEY`. |
| `OWNER_GRANT_TTL` | Lifetime. Bare seconds (`43200`) or a number with `s`, `m`, `h`, or `d` (`12h`). Default `12h`. |

When `OWNER_GRANT_SECRET` is unset, grants are signed with `CONNECTION_KEY` (`config.JWT_SECRET`). Rotating `CONNECTION_KEY` then revokes grants and session tokens together. Production should set `OWNER_GRANT_SECRET`.

The API does not log the grant or session JWTs.
