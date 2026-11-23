# Zelf Legacy — Mobile / WebView demo contract

**VerifikWallet (Android)** and **Zelf (iOS):** enable demo with app flags aligned to the API (`LEGACY_DEMO_MODE`). Android: `Constants.LEGACY_DEMO_MODE`. iOS: `LEGACY_DEMO_MODE` in `Info.plist` (see `Constants.legacyDemoMode`) and `Constants.legacyDemoLawyerAddress`. Both apps show a **DEMO ONLY** banner and pass `isDemo` via the embedded JS bridge (Android `tools/webview-bundle`; iOS `Zelf/Resources/InheritanceServer/bundle.js` from the same package). Use **Avalanche Fuji** only; never enable demo mode against production mainnet.

Demo inheritance plans skip lawyer manual acceptance and auto-confirm succession after the liveness period. **Production apps must not send `isDemo: true` unless pointed at a demo API with `LEGACY_DEMO_MODE=true`.**

## Prerequisites

- Demo API host has `LEGACY_DEMO_MODE=true` and `LEGACY_DEMO_LAWYER_ADDRESS` set.
- Call `GET /api/vault-legacy/demo/status` to read `enabled` and `demoLawyerAddress` for UI banners.

## Flow

### 1. Session

```http
POST /api/vault-legacy/sessions
{ "identifier": "<installation-id-or-wallet>" }
```

Use returned `token` as `Authorization: Bearer <token>` on all vault-legacy routes.

`VAULT_LEGACY_SESSION_PROOF` defaults to `legacy`, so this identifier-only body keeps working. The wallet-signature flow, relay binding, and daily relay caps are in `SESSION-PROOF.md`. Android and iOS should adopt that flow before the flag is set to `required`.

### 2. Register emails (before `createVault`)

```http
POST /api/vault-legacy/relay/register-emails
{
  "vaultId": "0x<bytes32-hex>",
  "isDemo": true,
  "testatorEmail": "user@example.com",
  "lawyerEmail": "optional@example.com",
  "beneficiaryEmails": ["ben@example.com"],
  "beneficiaryTagNames": ["beneficiary.zelf"]
}
```

### 3. Create vault on-chain

When building `createVault` calldata:

- Set **`lawyer`** to `demoLawyerAddress` from `/demo/status` (must match server `LEGACY_DEMO_LAWYER_ADDRESS`).
- Optionally use a shorter `heartbeatInterval` for staging; server default is `LEGACY_DEMO_HEARTBEAT_INTERVAL` when omitted.

Relay via `POST /api/vault-legacy/relay/send-tx` with the vault-legacy bearer token. `to` must be the configured vault registry, `value` must be omitted or `0`, and `calldata` must be one of `createVault`, `updateHeartbeat`, `cancelVault`, `changeLawyer`, `acceptVault`, `rejectVault`, `confirmDeath`, or `executeVault`. Other targets, values, and selectors are rejected with an `UPPER_SNAKE` `code`. The server **auto-accepts** demo vaults after creation; **do not** show a “waiting for lawyer acceptance” step.

### 4. Active plan & liveness

- Poll `GET /api/vault-legacy/avalanche/vault/:vaultId` — response includes `"isDemo": true`.
- Show a **“Demo inheritance plan”** badge when `isDemo` is true.
- Testator still uses **Confirm Liveness** (`updateHeartbeat`) in the app; if they do not, the server cron auto-confirms succession for demo vaults only.

### 5. Production builds

- Omit `isDemo` or send `isDemo: false`.
- Use production API without `LEGACY_DEMO_MODE`.
- Use real lawyer wallet addresses from the lawyer registry, not the demo lawyer address.

## Backend env (ops)

See `.env.example` — `LEGACY_DEMO_MODE`, `LEGACY_DEMO_LAWYER_ADDRESS`, optional `LEGACY_DEMO_LAWYER_PRIVATE_KEY` and `LEGACY_DEMO_HEARTBEAT_INTERVAL`.

Cron: `node Repositories/VaultLegacy/check-vaults.js` (schedule on demo/staging hosts).
