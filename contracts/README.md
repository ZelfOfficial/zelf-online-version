# Zelf contracts (Hardhat)

Isolated Hardhat workspace. Solidity sources live under `src/` (`avalanche/`, `erc8004/`). The Koa API at the repo root does **not** depend on Hardhat.

## Setup

```bash
cd contracts
npm install
```

Uses the repo-root `.env` for `WALRUS_PRIVATE_KEY` / `ERC8004_RPC_URL`.

## Commands

```bash
npm run compile
npm run deploy:erc8004:fuji
npm run deploy:erc8004:avalanche
```

From the repo root you can also run:

```bash
npm run contracts:compile
```

Avalanche ZelfKey NFT tooling lives under `Avalanche/`.
