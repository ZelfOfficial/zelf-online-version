# ZelfID

Online product API for names. Public host is **`https://v4.zelf.world`** (`GET https://v4.zelf.world/api/zelf-ids/search`). JWT required (protected registry).

Encrypt/decrypt/preview always use **ZelfEncrypt v4** (`ZELF_PROOF_V4_URL`, default `https://v4.zelf.world`, path `/zelf-v4`). JSON field names stay `tagName` / `tagObject` so existing clients can retarget from `/api/tags` with little churn.

v4 proofs from that host stay **unsigned** so Android/iOS can encrypt/decrypt offline. Face PKI: `GET https://v4.zelf.world/root-certificate`. Do not embed `ISSUERS_PUBLIC_KEY` on ZNS or Zelf ID APKs. ZelfEncrypt 3.1.6 (Tags, ZNS) stays unsigned and is reached on `https://v4.zelf.world` at `/zelf`.

`POST /lease-offline` pins an existing v4 proof (string and/or QR). Preview is **`previewHumanAuthn`** (Human Authn / `/zelf-v4`). Tags offline lease stays on `/api/tags/lease-offline`.

Names of 6–27 characters lease as `free` (no `.hold`) with a **100-year** internal `expiresAt` sentinel (UI: **No expiration**). A `$0` referral/complimentary quote on those names stays **free**. They can later buy **1–5 years** or **Lifetime** of **premium** or **unlimited** via `GET /payment-options?plan=` then `POST /payment-confirmation` or `POST /smart-contract-payment-confirmation` — not `/api/my-tags`. Lifetime charges the license 10-year price and stamps 100 years from today. Free → paid resets expiration from now; active paid yearly adds to the stored expiry; expired paid adds from today. Names of 5 characters or fewer are **unlimited only**. New unpaid short names use a **one-year** `name.domain.hold` pin (override: `ZELF_ID_RESERVATION_AMOUNT` / `ZELF_ID_RESERVATION_UNIT`). Legacy Tags holds keep their original stored expiry (often 30 days). When a paid term ends, the name stays and the plan reads as `free`. See public docs: [Migration v4 changelog](https://docs.zelf.world/docs/changelog/2026-08-31-zelf-id-migration-v4) and [Unit tests](https://docs.zelf.world/docs/api/zelf-ids/unit-tests).

Registered in `Routes/protected-repositories.js`.

## Endpoints

| Method | Path | Inbound (required) |
|--------|------|-------------------|
| GET | `/domains` | — |
| GET | `/domains/:domain` | path `domain` |
| GET | `/search` | `tagName`, `domain`; optional `os`, `environment`, `type`, `duration`, `key`, `value` |
| GET | `/search-by-domain` | `domain`, `storage` (`IPFS`\|`Arweave`\|`Walrus`); optional `name` |
| GET | `/preview` | `tagName`, `domain`, `os` |
| GET | `/wallet-balances` | optional address query fields |
| GET | `/payment-options` | `tagName`, `domain`, `duration` |
| POST | `/payment-confirmation` | `tagName`, `network`, `token`; optional `domain` |
| POST | `/smart-contract-payment-confirmation` | `tagName`, `network` (`AVAX_SC` / `BSC_SC` / `ETH_SC` / `POLYGON_SC` / `BASE_SC` / `BLOCKDAG_SC`), `token`, `txHash`; optional `domain` |
| POST | `/lease` | `tagName`, `domain`, `faceBase64`, `type` (`create`\|`import`), `os` |
| POST | `/lease-offline` | `tagName`, `domain`, plus `zelfProof` and/or `zelfProofQRCode`; optional `sync`, `syncPublicData`, `syncPassword`/`password` for address sync on an existing name |
| POST | `/sync-addresses` | `tagName`, `domain`, `syncPublicData` (address fields plus `_syncSignature`, `_syncIssuedAt`; no `zelfProof`) |
| POST | `/lease-recovery` | `zelfProof`, `tagName`, `domain`, `faceBase64`, `password`, `os` |
| DELETE | `/delete` | `tagName`, `domain`, `faceBase64` |
| POST | `/preview-zelfproof` | `zelfProof`, `os` |
| POST | `/preview-zelf-id-qr` | `zelfProofQRCode`, `os` |
| POST | `/decrypt` | `tagName`, `domain`, `faceBase64`, `os` |
| POST | `/revenue-cat` | RevenueCat `event` object |
| POST | `/purchase-rewards` | — (super admin; releases the oldest pending Tags purchase reward, 202 while its transfer is unconfirmed) |
| POST | `/referral-rewards` | — (super admin; 410, referral rewards are claimed per referral with `POST /api/my-tags/referrals/claim`) |

`os`: `DESKTOP` | `ANDROID` | `IOS`. New leases stamp `origin: "online"` and short `v: 4`. Short unpaid holds last one year by default; longer names lease as `free` and upgrade on payment.

## Example — POST `/api/zelf-ids/lease`

```json
{
  "tagName": "alice",
  "domain": "zelf",
  "faceBase64": "<session-encrypted or raw if removePGP>",
  "type": "create",
  "os": "DESKTOP",
  "password": "optional unless securityType is withoutPassword",
  "addServerPassword": false,
  "removePGP": true
}
```
