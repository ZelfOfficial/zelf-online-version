# ZelfID

Online product API for names. Public host is **`https://v4.zelf.world`** (`GET https://v4.zelf.world/api/zelf-ids/search`). JWT required (protected registry).

Encrypt/decrypt/preview always use **ZelfEncrypt v4** (`ZELF_PROOF_V4_URL`, default `https://v4.zelf.world`, path `/zelf-v4`). JSON field names stay `tagName` / `tagObject` so existing clients can retarget from `/api/tags` with little churn.

v4 proofs from that host stay **unsigned** so Android/iOS can encrypt/decrypt offline. Face PKI: `GET https://v4.zelf.world/root-certificate`. Do not embed `ISSUERS_PUBLIC_KEY` on ZNS or Zelf ID APKs. ZelfEncrypt 3.1.6 (Tags, ZNS) stays unsigned and is reached on `https://v4.zelf.world` at `/zelf`.

`POST /lease-offline` pins an existing v4 proof (string and/or QR). Preview is **`previewHumanAuthn`** (Human Authn / `/zelf-v4`). Tags offline lease stays on `/api/tags/lease-offline`.

Names of **1–5** characters lease as `free` on `name.zelf` (no `.hold`) and expire after the short-name hold (`ZELF_ID_RESERVATION_DURATION`, default **1 year**). Names of **6–27** characters lease as `free` for **100 years** (`FREE_EXPIRATION_YEARS`). Already stored records are not rewritten. A `$0` referral/complimentary quote stays **free**. They can later buy **1–5 years** or **Lifetime** via `GET /payment-options?plan=` then `POST /payment-confirmation` or `POST /smart-contract-payment-confirmation` — not `/api/my-tags`. Long names (6–27) may choose **premium** or **unlimited**; short names (1–5) may upgrade to **unlimited** only. Lifetime charges the license 10-year price and stamps 100 years from today. Free → paid resets expiration from now; active paid yearly adds to the stored expiry; expired paid adds from today. **Existing** `.hold` pins (legacy Tags or earlier v4) still block search until expiry or payment; payment-confirmation still converts them to paid mainnet. Env `ZELF_ID_RESERVATION_*` sets that short-name free term and the legacy `reserveZelfId` window. When a paid term ends, the name stays and the plan reads as `free`. See public docs: [Migration v4 changelog](https://docs.zelf.world/docs/changelog/2026-08-31-zelf-id-migration-v4) and [Unit tests](https://docs.zelf.world/docs/api/zelf-ids/unit-tests).

Registered in `Routes/protected-repositories.js`. `GET /referral-availability` is the exception: it is public (no JWT) and registered in `Routes/unprotected-repositories.js`.

## Endpoints

| Method | Path | Inbound (required) |
|--------|------|-------------------|
| GET | `/referral-availability` | `tagName` or `referralTagName` (bare name or `name.domain`); optional `domain` (default `zelf`). Public, no JWT. Per-IP limit 30/minute (`REFERRAL_AVAILABILITY_RATE_LIMIT_PER_MINUTE`), `429` `REFERRAL_LOOKUP_RATE_LIMITED` with `Retry-After` |
| GET | `/domains` | — |
| GET | `/domains/:domain` | path `domain` |
| GET | `/search` | `tagName`, `domain`; optional `os`, `environment`, `type`, `duration`, `key`, `value` |
| GET | `/search-by-domain` | `domain`, `storage` (`IPFS`\|`Arweave`\|`Walrus`); optional `name` |
| GET | `/preview` | `tagName`, `domain`, `os` |
| GET | `/wallet-balances` | optional address query fields |
| GET | `/my-plan` | `zelfName`. Verified owner (`verifiedTagName` matches, inside `verifiedUntil`). Returns plan, duration, expiresAt, paymentMethod, nextPlans, and upgrade action |
| GET | `/payment-options` | `tagName`, `domain`, `duration`; optional `plan`, `coupon` |
| POST | `/payment-confirmation` | `tagName`, `token`; `network` required unless the signed quote is a 100% coupon or other $0 quote (`freeCheckout`); a free checkout also requires identity verification for that Zelf ID (`faceBase64`, plus `masterPassword` when the wallet has one, or a session `verifiedTagName` still inside `verifiedUntil`); optional `domain` |
| POST | `/coupons` | super-admin. `code`, `percentOff` (1–100), `plans`, `maxRedemptions`; optional `durations`, `perZelfIdLimit`, `expiresAt` |
| GET | `/coupons` | super-admin list |
| POST | `/coupons/:id/deactivate` | super-admin. Sets `active` false and keeps the code |
| POST | `/smart-contract-payment-confirmation` | `tagName`, `network` (`AVAX_SC` / `BSC_SC` / `ETH_SC` / `POLYGON_SC` / `BASE_SC` / `BLOCKDAG_SC`), `token`, `txHash`; optional `domain` |
| POST | `/lease` | `tagName`, `domain`, `faceBase64`, `type` (`create`\|`import`), `os`. A referral whose inviter is already at `REFERRAL_REWARD_LIMIT` (default 10) is `409` `REFERRAL_LIMIT_REACHED`. Recovery (`/lease-recovery`) is not capped: restoring an account is not a new referral |
| POST | `/lease-offline` | `tagName`, `domain`, plus `zelfProof` and/or `zelfProofQRCode`; optional `sync`, `syncPublicData`, `syncPassword`/`password` for address sync on an existing name |
| POST | `/sync-addresses` | `tagName`, `domain`, `syncPublicData` (address fields plus `_syncSignature`, `_syncIssuedAt`; no `zelfProof`) |
| POST | `/lease-recovery` | `zelfProof`, `tagName`, `domain`, `faceBase64`, `password`, `os` |
| DELETE | `/delete` | `tagName`, `domain`, `faceBase64` |
| POST | `/preview-zelfproof` | `zelfProof`, `os` |
| POST | `/preview-zelf-id-qr` | `zelfProofQRCode`, `os` |
| POST | `/decrypt` | `tagName`, `domain`, `faceBase64`, `os` |
| POST | `/revenue-cat` | RevenueCat `event` object (`INITIAL_PURCHASE`, `RENEWAL`, `NON_RENEWING_PURCHASE`, `EXPIRATION`; products `zelf_premium_*` / `zelf_unlimited_*`) |
| POST | `/purchase-rewards` | — (super admin; releases the oldest pending Tags purchase reward, 202 while its transfer is unconfirmed) |
| POST | `/referral-rewards` | — (super admin; 410, referral rewards are claimed per referral with `POST /api/my-tags/referrals/claim`) |

`os`: `DESKTOP` | `ANDROID` | `IOS`. New leases stamp `origin: "online"` and short `v: 4`. All new leases are `free` mainnet; upgrade on payment when the client chooses a paid plan.

### Referral cap

`GET /api/zelf-ids/referral-availability?tagName=alice&domain=zelf` (also accepts `referralTagName` or `referral`). No session. Response `data` is only:

```json
{ "exists": true, "limit": 10, "spotsRemaining": 3, "acceptsNewReferrals": true }
```

Unknown inviter: `exists: false`, `spotsRemaining: 0`, `acceptsNewReferrals: false`, and the same `limit`. The body never includes the referral list, friend names, wallet addresses, emails, or plan.

A new signup (`POST /lease`, `POST /lease-offline`) or a checkout that attaches a referral not already stored on the record returns `409` with `code` and `message` `REFERRAL_LIMIT_REACHED` once `spotsRemaining` is 0. Address sync (`sync: true`) is not a new referral. The count is the same set used by `GET /api/my-tags/referrals` (`countedFriends` / the reward cap). Referrals already stored stay as they are, including ones over the cap. `POST /lease-recovery` does not return this error.

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
