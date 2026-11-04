# TON (The Open Network)

Portfolio scrapping, wallet derivation, transfers, and tag payment verification for TON.

## Wallet derivation

- BIP39 mnemonic (same as other Zelf chains)
- BIP44 path: `m/44'/607'/0'`
- Wallet contract: **V5R1**
- Test vector (`abandon`×11 + `about`): `EQBHyu-oZVDHRYQ1-rKlGqpHy5yAqanPBirEQNMNOmfHLotW`

## Protected endpoints (JWT required unless noted)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/ton/address/:id` | Dashboard (balance, jettons, recent txs) |
| GET | `/api/ton/address/:id/transactions` | Paginated transactions (`page`, `show`) |
| GET | `/api/ton/address/:id/tokens` | Jetton holdings |
| GET | `/api/ton/transaction/:id` | Transaction detail |
| GET | `/api/ton/payment/service-wallet` | Tag payment destination (**public**, unprotected) |
| POST | `/api/ton/payment/confirm` | Verify on-chain tag payment |
| POST | `/api/ton/transfer/send` | Sign and broadcast native TON transfer |
| POST | `/api/ton/transfer/jetton` | Sign and broadcast Jetton transfer |

## Environment

See `.env.example`: `TON_RPC_URL`, `TON_API_KEY`, `TON_INDEXER_URL`, `TON_SERVICE_WALLET_ADDRESS`.

`TON_API_KEY` is optional but recommended for production and QA: TonAPI uses it as a Bearer token and TonCenter as `X-API-Key`, which reduces anonymous rate limits (429) on balance and payment lookups.

Native TON token icon: `https://cdn.zelf.world/icons/ic_ton.png`

Public API examples should use `https://v4.zelf.world` in external documentation.
