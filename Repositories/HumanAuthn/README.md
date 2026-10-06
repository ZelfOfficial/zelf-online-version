# HumanAuthn

Raw ZelfEncrypt **v4** encrypt/decrypt/preview. Same shape as `/api/zelf-proof`, different stack.

| Path | Stack |
|------|--------|
| `/api/human-authn/*` | v4 (`https://v4.zelf.world` + `/zelf-v4`) |
| `/api/zelf-proof/*` | legacy (`https://v4.zelf.world` + `/zelf`) |
| `/api/human-authn/upgrade` | v4 `POST /zelf-v4/upgrade` → SenseCrypt `/refresh-senseprint-face` (402) |
| `/api/jwt/human-authn/upgrade` | same upgrade, JWT only, `NODE_ENV=development` |

Unprotected (optional JWT). Encrypt/decrypt/preview/QR require **payment (HTTP 402)** unless the caller has a valid subscription. `GET /api/human-authn/payment-stats` has no payment.

Registered in `Routes/unprotected-repositories.js`. Onboarding progress is JWT-protected: `GET /api/human-authn/onboarding-progress`.

## Face Certificates (v4)

Face PKI lives only on `https://v4.zelf.world` (`pki_private_key`, `GET /root-certificate`). Proofs on that host stay **unsigned** so Android/iOS can encrypt/decrypt offline. Do not embed `ISSUERS_PUBLIC_KEY` on ZNS or Zelf ID APKs. ZelfEncrypt 3.1.6 stays unsigned (ZNS) and is reached on `https://v4.zelf.world` at `/zelf`.

Koa should call v4 with `ZELF_PROOF_V4_URL=https://v4.zelf.world` (path prefix `/zelf-v4`). Online encrypt through this API is unchanged.

`POST /api/human-authn/upgrade` re-issues a 3.1.6 (or older) proof as a v4 SensePrint. Koa posts to `https://v4.zelf.world/zelf-v4/upgrade` (SenseCrypt `/refresh-senseprint-face`).

Optional Face Certificate verifiers can pin `https://v4.zelf.world/root-certificate` or `GET /api/face-certificates/root-certificate`. Koa Face Certificate routes live in `Repositories/FaceCertificates/` (`/api/face-certificates` + `/api/my-face-certificates`). Never ship PKI or issuer private keys in apps, the extension, the dashboard, or git.

## Inbound

`livenessLevel`: `REGULAR` | `SOFT` | `HARDENED`. `os`: `DESKTOP` | `ANDROID` | `IOS`. `tolerance` (optional): same enum as `livenessLevel`.

### POST `/api/human-authn/encrypt`

```json
{
  "faceBase64": "<base64 or data URL>",
  "metadata": { "mnemonic": "..." },
  "identifier": "record-id",
  "livenessLevel": "REGULAR",
  "os": "DESKTOP",
  "publicData": { "name": "optional" },
  "password": "optional",
  "requireLiveness": true,
  "tolerance": "REGULAR",
  "verifierKey": "optional",
  "livenessDetectionPriorCreation": false
}
```

Response: `{ "zelfID": "<proof>" }`.

### POST `/api/human-authn/encrypt-qr-code`

Same body as encrypt. Optional `generateZelfProof`. Response: `{ "zelfIDQR": "data:image/png;base64,...", "zelfID": "<proof?>" }`.

### POST `/api/human-authn/decrypt`

```json
{
  "faceBase64": "<base64>",
  "os": "DESKTOP",
  "zelfProof": "<proof>",
  "password": "optional",
  "verifierKey": "optional"
}
```

### POST `/api/human-authn/preview`

```json
{
  "zelfProof": "<proof>",
  "verifierKey": "optional"
}
```

### POST `/api/human-authn/upgrade`

Re-issues `zelfProof` as a v4 SensePrint. Same face as the original proof. Liveness is not checked during refresh.

```json
{
  "faceBase64": "<base64>",
  "os": "DESKTOP",
  "zelfProof": "<3.1.6 or v4 proof>",
  "password": "optional",
  "requireLiveness": true,
  "verifierKey": "optional"
}
```

Response: `{ "zelfID": "<v4 proof>" }`. Paid path is 402 without ZNS payment. Dev JWT mirror: `POST /api/jwt/human-authn/upgrade`.
