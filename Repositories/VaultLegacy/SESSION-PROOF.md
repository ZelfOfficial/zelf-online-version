# Vault-legacy session proof

Android (**VerifikWallet**, `ZelfOfficial/zelf-android-online` branch `v4`) and iOS (**Zelf**, `ZelfOfficial/zelf-ios-offline` branch `v4`) obtain the vault-legacy bearer the same way today, and both can keep doing that until `VAULT_LEGACY_SESSION_PROOF=required`.

## What the apps do today

Both apps post an installation id and cache the token for 23 hours.

| | Android | iOS |
| --- | --- | --- |
| Caller | `InheritanceSessionManager.getSessionToken()` | `InheritanceSessionManager.fetchToken()` |
| Identifier | `Installation.id` — a UUID stored in the app files dir (`utils/Installation.java`) | `UIDevice.current.identifierForVendor`, or a random UUID if that is nil |
| Request | `POST {ZELF_LEGACY_BACKEND_URL}/api/vault-legacy/sessions` with `{"identifier":"<uuid>"}` | same path on `Constants.zelfLegacyBackendURL` |
| Cache | SharedPreferences `inheritance_session_token` / `inheritance_session_date`, refresh after 23 hours | UserDefaults `inheritance_session_token` / `inheritance_session_date`, same 23 hours |
| Use | `Authorization: Bearer <token>` on `ApiInheritanceInterface`, and `config.bearerToken` passed into the hidden WebView | `InheritanceAPIClient` sends the same header; the WebView bundle receives the same bearer |

The WebView (`tools/webview-bundle/src/avalanche-manager.js`, copied to iOS `Zelf/Resources/InheritanceServer`) calls `POST /api/vault-legacy/relay/send-tx` with `{ "to", "calldata" }` and that bearer. It does **not** send the per-call `authSig` to the relayer. The native layer already builds an EIP-191 `authSig` (`sig`, `signedMessage`, `address`) for vault writes such as `ZelfLegacy create-vault …`. That signature is checked in the WebView and on the `/api/vault-legacy/avalanche/*` routes. The installation UUID has no private key, so the proof the apps can add is a signature from the Avalanche wallet that will relay.

One installation token is reused for every relay on that device. After proof is turned on, the token is bound to the wallet that signed the challenge. Mint one token per wallet (testator, lawyer, and beneficiary each sign on their own device with their own key).

## Server flag

`VAULT_LEGACY_SESSION_PROOF`

| Value | Behavior |
| --- | --- |
| `legacy` (default, and any value other than `required`) | `{ "identifier" }` still returns a 24-hour token with `proof: "legacy"`. The server logs `vault_legacy_session_issued`. If the body includes a valid challenge signature, the server issues a proven token instead. |
| `required` | `{ "identifier" }` alone returns `401` `SESSION_PROOF_REQUIRED`. Relay calls whose token has no proven wallet return `403` `RELAY_IDENTITY_REQUIRED`. |

Ship the server with the default first. Current builds keep working. Release Android and iOS that send the proof, then set the flag to `required` once those builds are the ones in use.

Proven tokens also enforce relay identity while the flag is still `legacy`. A legacy token does not.

## What Android and iOS change

No change to the relay JSON. The WebView keeps sending `{ "to", "calldata" }` with the bearer. Change session minting only.

1. Keep the same `identifier` (the installation UUID). Also take the active Avalanche address — the same wallet that already signs `authSig`.
2. `POST /api/vault-legacy/sessions/challenge`

```json
{ "identifier": "550e8400-e29b-41d4-a716-446655440000", "address": "0xAbc…" }
```

3. Sign the **exact** `message` string with EIP-191 `personal_sign` (`ethers.Wallet.signMessage` / the same primitive already used for `authSig.sig`). Do not rebuild the message.
4. `POST /api/vault-legacy/sessions`

```json
{
  "identifier": "550e8400-e29b-41d4-a716-446655440000",
  "challengeId": "<challengeId from step 2>",
  "authSig": {
    "sig": "0x…",
    "signedMessage": "<exact message from step 2>",
    "address": "0xAbc…"
  }
}
```

5. Cache `token` until `expiresIn` seconds (default **3600** for a proven token, not 23 hours), keyed by the lowercase wallet address. Refresh with a new challenge when the wallet changes or the token is inside the last minute of `expiresIn`.
6. Pass that token as `bearerToken` / `Authorization` exactly as today.

If `identifier` itself is an Ethereum address, it must be the signing address. The installation-id path above is the one both apps should use.

Message shape (the server returns this; clients only sign it):

```text
ZelfLegacy session
identifier: <identifier>
address: <checksum address>
nonce: <32 hex chars>
expires: <unix seconds>
```

### Android

`app/src/main/java/co/verifik/wallet/data/remote/InheritanceSessionManager.kt`

- Add the wallet address and a signer to `getSessionToken()` (the call sites in the inheritance screens know which wallet is active).
- Replace the single SharedPreferences slot with a slot per address.
- Replace `REFRESH_THRESHOLD_MS` (23 hours) with the `expiresIn` value from the response.
- On `401` `SESSION_PROOF_REQUIRED` or `403` `RELAY_IDENTITY_REQUIRED`, clear the cached token and mint again with a signature. Do not fall back to an identifier-only body once the server flag is `required`.

`ApiInheritanceInterface.auth` can stay for the legacy body. Add the challenge call beside it, or keep using `HttpURLConnection` as `getSessionToken()` does today.

### iOS

`Zelf/Screens/Inheritance/Data/InheritanceSessionManager.swift`

- Same steps: challenge, `personal_sign` with the active Avalanche wallet, then session.
- Replace the 23-hour `refreshThreshold` with `expiresIn`.
- Key `inheritance_session_token` by wallet address.

`InheritanceAPIClient` stays a bearer client. It does not need a new relay body.

## Relay identity

For a proven token, `POST /api/vault-legacy/relay/send-tx` allows:

| Call | Proven wallet must be |
| --- | --- |
| `createVault` | the `_owner` argument |
| `updateHeartbeat`, `cancelVault`, `changeLawyer` | the vault owner on the registry |
| `acceptVault`, `rejectVault`, `confirmDeath` | the vault lawyer on the registry |
| `executeVault` | the `_beneficiary` argument, and that address must be a beneficiary of the vault |

If the registry vault cannot be read, the call returns `403` `RELAY_VAULT_UNVERIFIED`.

`POST /api/vault-legacy/relay/register-emails` treats `proof: "eip191"` plus `ethAddress` as the owner when the vault is not on chain yet. A legacy installation id still cannot register emails before the vault exists.

## Limits

Counted when a relay call has passed the checks above and is about to be submitted. UTC day.

| Env | Default | Code when exceeded |
| --- | --- | --- |
| `VAULT_LEGACY_RELAY_DAILY_CAP` | 20 per proven wallet, or per legacy identifier | `429` `RELAY_DAILY_CAP_EXCEEDED` |
| `VAULT_LEGACY_RELAY_IP_DAILY_CAP` | 200 per client address | `429` `RELAY_IP_DAILY_CAP_EXCEEDED` |
| `VAULT_LEGACY_CHALLENGE_PER_IP_PER_MINUTE` | 30 | `429` `CHALLENGE_RATE_LIMITED` |
| `VAULT_LEGACY_SESSION_PER_IP_PER_MINUTE` | 60 | `429` `SESSION_RATE_LIMITED` |
| `VAULT_LEGACY_PROVEN_SESSION_TTL_SECONDS` | 3600 (min 60, max 86400) | — |
| `VAULT_LEGACY_CHALLENGE_TTL_SECONDS` | 300 (min 30, max 900) | — |

Legacy session TTL stays 86400. Shared-NAT deployments can raise `VAULT_LEGACY_RELAY_IP_DAILY_CAP`.

Counters and single-use challenges are stored in Mongo while the API is connected (`VaultLegacySessionChallenge`, `VaultLegacyRelayUsage`). `VAULT_LEGACY_STATE_STORE=memory` forces process-local state.

## Error codes

All `error` and `code` values are `UPPER_SNAKE`.

Session: `IDENTIFIER_REQUIRED`, `IDENTIFIER_INVALID`, `SESSION_ADDRESS_REQUIRED`, `SESSION_ADDRESS_MISMATCH`, `SESSION_PROOF_REQUIRED`, `SESSION_PROOF_INCOMPLETE`, `SESSION_MESSAGE_MISMATCH`, `SESSION_SIGNATURE_INVALID`, `SESSION_NOT_CONFIGURED`, `SESSION_RATE_LIMITED`, `SESSION_FAILED`, `CHALLENGE_NOT_FOUND`, `CHALLENGE_IDENTIFIER_MISMATCH`, `CHALLENGE_CONSUMED`, `CHALLENGE_EXPIRED`, `CHALLENGE_RATE_LIMITED`, `CHALLENGE_STORE_UNAVAILABLE`.

Relay: `RELAY_IDENTITY_REQUIRED`, `RELAY_IDENTITY_MISMATCH`, `RELAY_VAULT_UNVERIFIED`, `RELAY_DAILY_CAP_EXCEEDED`, `RELAY_IP_DAILY_CAP_EXCEEDED`, `RELAY_USAGE_UNAVAILABLE`.
